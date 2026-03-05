import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadConfig,
  resolveConfigPath,
  resolveGatewayPort,
  resolveStateDir,
} from "../config/config.js";
import { hasConfiguredSecretInput, resolveSecretInputRef } from "../config/types.secrets.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import { secretRefKey } from "../secrets/ref-contract.js";
import { resolveSecretRefValues } from "../secrets/resolve.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { VERSION } from "../version.js";
import { GatewayClient } from "./client.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";
import {
  CLI_DEFAULT_OPERATOR_SCOPES,
  resolveLeastPrivilegeOperatorScopesForMethod,
  type OperatorScope,
} from "./method-scopes.js";
import { isSecureWebSocketUrl } from "./net.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";

type CallGatewayBaseOptions = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  config?: OpenClawConfig;
  method: string;
  params?: unknown;
  expectFinal?: boolean;
  timeoutMs?: number;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  minProtocol?: number;
  maxProtocol?: number;
  requiredMethods?: string[];
  /**
   * Overrides the config path shown in connection error details.
   * Does not affect config loading; callers still control auth via opts.token/password/env/config.
   */
  configPath?: string;
};

export type CallGatewayScopedOptions = CallGatewayBaseOptions & {
  scopes: OperatorScope[];
};

export type CallGatewayCliOptions = CallGatewayBaseOptions & {
  scopes?: OperatorScope[];
};

export type CallGatewayOptions = CallGatewayBaseOptions & {
  scopes?: OperatorScope[];
};

export type GatewayConnectionDetails = {
  url: string;
  urlSource: string;
  bindDetail?: string;
  remoteFallbackNote?: string;
  message: string;
};

export type ExplicitGatewayAuth = {
  token?: string;
  password?: string;
};

export function resolveExplicitGatewayAuth(opts?: ExplicitGatewayAuth): ExplicitGatewayAuth {
  const token =
    typeof opts?.token === "string" && opts.token.trim().length > 0 ? opts.token.trim() : undefined;
  const password =
    typeof opts?.password === "string" && opts.password.trim().length > 0
      ? opts.password.trim()
      : undefined;
  return { token, password };
}

export function ensureExplicitGatewayAuth(params: {
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  explicitAuth?: ExplicitGatewayAuth;
  resolvedAuth?: ExplicitGatewayAuth;
  errorHint: string;
  configPath?: string;
}): void {
  if (!params.urlOverride) {
    return;
  }
  // URL overrides are untrusted redirects and can move WebSocket traffic off the intended host.
  // Never allow an override to silently reuse implicit credentials or device token fallback.
  const explicitToken = params.explicitAuth?.token;
  const explicitPassword = params.explicitAuth?.password;
  if (params.urlOverrideSource === "cli" && (explicitToken || explicitPassword)) {
    return;
  }
  const hasResolvedAuth =
    params.resolvedAuth?.token ||
    params.resolvedAuth?.password ||
    explicitToken ||
    explicitPassword;
  // Env overrides are supported for deployment ergonomics, but only when explicit auth is available.
  // This avoids implicit device-token fallback against attacker-controlled WSS endpoints.
  if (params.urlOverrideSource === "env" && hasResolvedAuth) {
    return;
  }
  const message = [
    "gateway url override requires explicit credentials",
    params.errorHint,
    params.configPath ? `Config: ${params.configPath}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  throw new Error(message);
}

export function buildGatewayConnectionDetails(
  options: {
    config?: OpenClawConfig;
    url?: string;
    configPath?: string;
    urlSource?: "cli" | "env";
  } = {},
): GatewayConnectionDetails {
  const config = options.config ?? loadConfig();
  const configPath =
    options.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;
  const tlsEnabled = config.gateway?.tls?.enabled === true;
  const localPort = resolveGatewayPort(config);
  const bindMode = config.gateway?.bind ?? "loopback";
  const scheme = tlsEnabled ? "wss" : "ws";
  // Self-connections should always target loopback; bind mode only controls listener exposure.
  const localUrl = `${scheme}://127.0.0.1:${localPort}`;
  const cliUrlOverride =
    typeof options.url === "string" && options.url.trim().length > 0
      ? options.url.trim()
      : undefined;
  const envUrlOverride = cliUrlOverride
    ? undefined
    : (trimToUndefined(process.env.OPENCLAW_GATEWAY_URL) ??
      trimToUndefined(process.env.CLAWDBOT_GATEWAY_URL));
  const urlOverride = cliUrlOverride ?? envUrlOverride;
  const remoteUrl =
    typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : undefined;
  const remoteMisconfigured = isRemoteMode && !urlOverride && !remoteUrl;
  const urlSourceHint =
    options.urlSource ?? (cliUrlOverride ? "cli" : envUrlOverride ? "env" : undefined);
  const url = urlOverride || remoteUrl || localUrl;
  const urlSource = urlOverride
    ? urlSourceHint === "env"
      ? "env OPENCLAW_GATEWAY_URL"
      : "cli --url"
    : remoteUrl
      ? "config gateway.remote.url"
      : remoteMisconfigured
        ? "missing gateway.remote.url (fallback local)"
        : "local loopback";
  const bindDetail = !urlOverride && !remoteUrl ? `Bind: ${bindMode}` : undefined;
  const remoteFallbackNote = remoteMisconfigured
    ? "Warn: gateway.mode=remote but gateway.remote.url is missing; set gateway.remote.url or switch gateway.mode=local."
    : undefined;

  const allowPrivateWs = process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1";
  // Security check: block ALL insecure ws:// to non-loopback addresses (CWE-319, CVSS 9.8)
  // This applies to the FINAL resolved URL, regardless of source (config, CLI override, etc).
  // Both credentials and chat/conversation data must not be transmitted over plaintext to remote hosts.
  if (!isSecureWebSocketUrl(url, { allowPrivateWs })) {
    throw new Error(
      [
        `SECURITY ERROR: Gateway URL "${url}" uses plaintext ws:// to a non-loopback address.`,
        "Both credentials and chat data would be exposed to network interception.",
        `Source: ${urlSource}`,
        `Config: ${configPath}`,
        "Fix: Use wss:// for remote gateway URLs.",
        "Safe remote access defaults:",
        "- keep gateway.bind=loopback and use an SSH tunnel (ssh -N -L 18789:127.0.0.1:18789 user@gateway-host)",
        "- or use Tailscale Serve/Funnel for HTTPS remote access",
        allowPrivateWs
          ? undefined
          : "Break-glass (trusted private networks only): set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1",
        "Doctor: openclaw doctor --fix",
        "Docs: https://docs.openclaw.ai/gateway/remote",
      ].join("\n"),
    );
  }

  const message = [
    `Gateway target: ${url}`,
    `Source: ${urlSource}`,
    `Config: ${configPath}`,
    bindDetail,
    remoteFallbackNote,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    url,
    urlSource,
    bindDetail,
    remoteFallbackNote,
    message,
  };
}

type GatewayRemoteSettings = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
};

type ResolvedGatewayCallContext = {
  config: OpenClawConfig;
  configPath: string;
  isRemoteMode: boolean;
  remote?: GatewayRemoteSettings;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  remoteUrl?: string;
  explicitAuth: ExplicitGatewayAuth;
};

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readGatewayTokenEnv(env: NodeJS.ProcessEnv): string | undefined {
  return trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN) ?? trimToUndefined(env.CLAWDBOT_GATEWAY_TOKEN);
}

function readGatewayPasswordEnv(env: NodeJS.ProcessEnv): string | undefined {
  return (
    trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD) ?? trimToUndefined(env.CLAWDBOT_GATEWAY_PASSWORD)
  );
}

function resolveGatewayCallTimeout(timeoutValue: unknown): {
  timeoutMs: number;
  safeTimerTimeoutMs: number;
} {
  const timeoutMs =
    typeof timeoutValue === "number" && Number.isFinite(timeoutValue) ? timeoutValue : 10_000;
  const safeTimerTimeoutMs = Math.max(1, Math.min(Math.floor(timeoutMs), 2_147_483_647));
  return { timeoutMs, safeTimerTimeoutMs };
}

function resolveGatewayCallContext(opts: CallGatewayBaseOptions): ResolvedGatewayCallContext {
  const config = opts.config ?? loadConfig();
  const configPath =
    opts.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode
    ? (config.gateway?.remote as GatewayRemoteSettings | undefined)
    : undefined;
  const cliUrlOverride = trimToUndefined(opts.url);
  const envUrlOverride = cliUrlOverride
    ? undefined
    : (trimToUndefined(process.env.OPENCLAW_GATEWAY_URL) ??
      trimToUndefined(process.env.CLAWDBOT_GATEWAY_URL));
  const urlOverride = cliUrlOverride ?? envUrlOverride;
  const urlOverrideSource = cliUrlOverride ? "cli" : envUrlOverride ? "env" : undefined;
  const remoteUrl = trimToUndefined(remote?.url);
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  return {
    config,
    configPath,
    isRemoteMode,
    remote,
    urlOverride,
    urlOverrideSource,
    remoteUrl,
    explicitAuth,
  };
}

export function resolveDeviceIdentityPathFromConfig(configPath?: string): string | undefined {
  const trimmed = configPath?.trim();
  if (!trimmed) {
    return undefined;
  }
  return path.join(path.dirname(trimmed), "identity", "device.json");
}

function ensureRemoteModeUrlConfigured(context: ResolvedGatewayCallContext): void {
  if (!context.isRemoteMode || context.urlOverride || context.remoteUrl) {
    return;
  }
  throw new Error(
    [
      "gateway remote mode misconfigured: gateway.remote.url missing",
      `Config: ${context.configPath}`,
      "Fix: set gateway.remote.url, or set gateway.mode=local.",
    ].join("\n"),
  );
}

async function resolveGatewaySecretInputString(params: {
  config: OpenClawConfig;
  value: unknown;
  path: string;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const defaults = params.config.secrets?.defaults;
  const { ref } = resolveSecretInputRef({
    value: params.value,
    defaults,
  });
  if (!ref) {
    return trimToUndefined(params.value);
  }
  const resolved = await resolveSecretRefValues([ref], {
    config: params.config,
    env: params.env,
  });
  const resolvedValue = trimToUndefined(resolved.get(secretRefKey(ref)));
  if (!resolvedValue) {
    throw new Error(`${params.path} resolved to an empty or non-string value.`);
  }
  return resolvedValue;
}

async function resolveGatewayCredentials(context: ResolvedGatewayCallContext): Promise<{
  token?: string;
  password?: string;
}> {
  return resolveGatewayCredentialsWithEnv(context, process.env);
}

async function resolveGatewayCredentialsWithEnv(
  context: ResolvedGatewayCallContext,
  env: NodeJS.ProcessEnv,
): Promise<{
  token?: string;
  password?: string;
}> {
  if (context.explicitAuth.token || context.explicitAuth.password) {
    return {
      token: context.explicitAuth.token,
      password: context.explicitAuth.password,
    };
  }
  if (context.urlOverride) {
    return resolveGatewayCredentialsFromConfig({
      cfg: context.config,
      env,
      explicitAuth: context.explicitAuth,
      urlOverride: context.urlOverride,
      urlOverrideSource: context.urlOverrideSource,
      remotePasswordPrecedence: "env-first",
    });
  }

  let resolvedConfig = context.config;
  const envToken = readGatewayTokenEnv(env);
  const envPassword = readGatewayPasswordEnv(env);
  const defaults = context.config.secrets?.defaults;
  const auth = context.config.gateway?.auth;
  const remoteConfig = context.config.gateway?.remote;
  const authMode = auth?.mode;
  const localToken = trimToUndefined(auth?.token);
  const remoteToken = trimToUndefined(remoteConfig?.token);
  const remoteTokenConfigured = hasConfiguredSecretInput(remoteConfig?.token, defaults);
  const tokenCanWin = Boolean(envToken || localToken || remoteToken || remoteTokenConfigured);
  const remotePasswordConfigured =
    context.isRemoteMode && hasConfiguredSecretInput(remoteConfig?.password, defaults);
  const localPasswordRef = resolveSecretInputRef({ value: auth?.password, defaults }).ref;
  const localPasswordCanWinInLocalMode =
    authMode === "password" ||
    (authMode !== "token" && authMode !== "none" && authMode !== "trusted-proxy" && !tokenCanWin);
  const localTokenCanWinInLocalMode =
    authMode !== "password" && authMode !== "none" && authMode !== "trusted-proxy";
  const localPasswordCanWinInRemoteMode = !remotePasswordConfigured && !tokenCanWin;
  const shouldResolveLocalPassword =
    Boolean(auth) &&
    !envPassword &&
    Boolean(localPasswordRef) &&
    (context.isRemoteMode ? localPasswordCanWinInRemoteMode : localPasswordCanWinInLocalMode);
  if (shouldResolveLocalPassword) {
    resolvedConfig = structuredClone(context.config);
    const resolvedPassword = await resolveGatewaySecretInputString({
      config: resolvedConfig,
      value: resolvedConfig.gateway?.auth?.password,
      path: "gateway.auth.password",
      env,
    });
    if (resolvedConfig.gateway?.auth) {
      resolvedConfig.gateway.auth.password = resolvedPassword;
    }
  }
  const remote = context.isRemoteMode ? resolvedConfig.gateway?.remote : undefined;
  const resolvedDefaults = resolvedConfig.secrets?.defaults;
  if (remote) {
    const localToken = trimToUndefined(resolvedConfig.gateway?.auth?.token);
    const localPassword = trimToUndefined(resolvedConfig.gateway?.auth?.password);
    const passwordCanWinBeforeRemoteTokenResolution = Boolean(
      envPassword || localPassword || trimToUndefined(remote.password),
    );
    const remoteTokenRef = resolveSecretInputRef({
      value: remote.token,
      defaults: resolvedDefaults,
    }).ref;
    if (!passwordCanWinBeforeRemoteTokenResolution && !envToken && !localToken && remoteTokenRef) {
      remote.token = await resolveGatewaySecretInputString({
        config: resolvedConfig,
        value: remote.token,
        path: "gateway.remote.token",
        env,
      });
    }

    const tokenCanWin = Boolean(envToken || localToken || trimToUndefined(remote.token));
    const remotePasswordRef = resolveSecretInputRef({
      value: remote.password,
      defaults: resolvedDefaults,
    }).ref;
    if (!tokenCanWin && !envPassword && !localPassword && remotePasswordRef) {
      remote.password = await resolveGatewaySecretInputString({
        config: resolvedConfig,
        value: remote.password,
        path: "gateway.remote.password",
        env,
      });
    }
  }
  const localModeRemote = !context.isRemoteMode ? resolvedConfig.gateway?.remote : undefined;
  if (localModeRemote) {
    const localToken = trimToUndefined(resolvedConfig.gateway?.auth?.token);
    const localPassword = trimToUndefined(resolvedConfig.gateway?.auth?.password);
    const localModePasswordSourceConfigured = Boolean(
      envPassword || localPassword || trimToUndefined(localModeRemote.password),
    );
    const passwordCanWinBeforeRemoteTokenResolution =
      localPasswordCanWinInLocalMode && localModePasswordSourceConfigured;
    const remoteTokenRef = resolveSecretInputRef({
      value: localModeRemote.token,
      defaults: resolvedDefaults,
    }).ref;
    if (
      localTokenCanWinInLocalMode &&
      !passwordCanWinBeforeRemoteTokenResolution &&
      !envToken &&
      !localToken &&
      remoteTokenRef
    ) {
      localModeRemote.token = await resolveGatewaySecretInputString({
        config: resolvedConfig,
        value: localModeRemote.token,
        path: "gateway.remote.token",
        env,
      });
    }
    const tokenCanWin = Boolean(envToken || localToken || trimToUndefined(localModeRemote.token));
    const remotePasswordRef = resolveSecretInputRef({
      value: localModeRemote.password,
      defaults: resolvedDefaults,
    }).ref;
    if (
      !tokenCanWin &&
      !envPassword &&
      !localPassword &&
      remotePasswordRef &&
      localPasswordCanWinInLocalMode
    ) {
      localModeRemote.password = await resolveGatewaySecretInputString({
        config: resolvedConfig,
        value: localModeRemote.password,
        path: "gateway.remote.password",
        env,
      });
    }
  }
  return resolveGatewayCredentialsFromConfig({
    cfg: resolvedConfig,
    env,
    explicitAuth: context.explicitAuth,
    urlOverride: context.urlOverride,
    urlOverrideSource: context.urlOverrideSource,
    remotePasswordPrecedence: "env-first",
  });
}

export async function resolveGatewayCredentialsWithSecretInputs(params: {
  config: OpenClawConfig;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ token?: string; password?: string }> {
  const context: ResolvedGatewayCallContext = {
    config: params.config,
    configPath: resolveConfigPath(process.env, resolveStateDir(process.env)),
    isRemoteMode: params.config.gateway?.mode === "remote",
    remote:
      params.config.gateway?.mode === "remote"
        ? (params.config.gateway?.remote as GatewayRemoteSettings | undefined)
        : undefined,
    urlOverride: trimToUndefined(params.urlOverride),
    remoteUrl:
      params.config.gateway?.mode === "remote"
        ? trimToUndefined((params.config.gateway?.remote as GatewayRemoteSettings | undefined)?.url)
        : undefined,
    explicitAuth: resolveExplicitGatewayAuth(params.explicitAuth),
  };
  return resolveGatewayCredentialsWithEnv(context, params.env ?? process.env);
}

async function resolveGatewayTlsFingerprint(params: {
  opts: CallGatewayBaseOptions;
  context: ResolvedGatewayCallContext;
  url: string;
}): Promise<string | undefined> {
  const { opts, context, url } = params;
  const useLocalTls =
    context.config.gateway?.tls?.enabled === true &&
    !context.urlOverrideSource &&
    !context.remoteUrl &&
    url.startsWith("wss://");
  const tlsRuntime = useLocalTls
    ? await loadGatewayTlsRuntime(context.config.gateway?.tls)
    : undefined;
  const overrideTlsFingerprint = trimToUndefined(opts.tlsFingerprint);
  const remoteTlsFingerprint =
    // Env overrides may still inherit configured remote TLS pinning for private cert deployments.
    // CLI overrides remain explicit-only and intentionally skip config remote TLS to avoid
    // accidentally pinning against caller-supplied target URLs.
    context.isRemoteMode && context.urlOverrideSource !== "cli"
      ? trimToUndefined(context.remote?.tlsFingerprint)
      : undefined;
  return (
    overrideTlsFingerprint ||
    remoteTlsFingerprint ||
    (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined)
  );
}

function formatGatewayCloseError(
  code: number,
  reason: string,
  connectionDetails: GatewayConnectionDetails,
): string {
  const reasonText = reason?.trim() || "no close reason";
  const hint =
    code === 1006 ? "abnormal closure (no close frame)" : code === 1000 ? "normal closure" : "";
  const suffix = hint ? ` ${hint}` : "";
  return `gateway closed (${code}${suffix}): ${reasonText}\n${connectionDetails.message}`;
}

function formatGatewayTimeoutError(
  timeoutMs: number,
  connectionDetails: GatewayConnectionDetails,
): string {
  return `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
}

function ensureGatewaySupportsRequiredMethods(params: {
  requiredMethods: string[] | undefined;
  methods: string[] | undefined;
  attemptedMethod: string;
}): void {
  const requiredMethods = Array.isArray(params.requiredMethods)
    ? params.requiredMethods.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [];
  if (requiredMethods.length === 0) {
    return;
  }
  const supportedMethods = new Set(
    (Array.isArray(params.methods) ? params.methods : [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  for (const method of requiredMethods) {
    if (supportedMethods.has(method)) {
      continue;
    }
    throw new Error(
      [
        `active gateway does not support required method "${method}" for "${params.attemptedMethod}".`,
        "Update the gateway or run without SecretRefs.",
      ].join(" "),
    );
  }
}

async function executeGatewayRequestWithScopes<T>(params: {
  opts: CallGatewayBaseOptions;
  scopes: OperatorScope[];
  url: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  timeoutMs: number;
  safeTimerTimeoutMs: number;
  connectionDetails: GatewayConnectionDetails;
}): Promise<T> {
  const { opts, scopes, url, token, password, tlsFingerprint, timeoutMs, safeTimerTimeoutMs } =
    params;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let ignoreClose = false;
    const stop = (err?: Error, value?: T) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(value as T);
      }
    };

    const client = new GatewayClient({
      url,
      token,
      password,
      tlsFingerprint,
      instanceId: opts.instanceId ?? randomUUID(),
      clientName: opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
      clientDisplayName: opts.clientDisplayName,
      clientVersion: opts.clientVersion ?? VERSION,
      platform: opts.platform,
      mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI,
      role: "operator",
      scopes,
      deviceIdentity: loadOrCreateDeviceIdentity(
        resolveDeviceIdentityPathFromConfig(params.connectionDetails.configPath),
      ),
      minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,
      maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
      onHelloOk: async (hello) => {
        try {
          ensureGatewaySupportsRequiredMethods({
            requiredMethods: opts.requiredMethods,
            methods: hello.features?.methods,
            attemptedMethod: opts.method,
          });
          const result = await client.request<T>(opts.method, opts.params, {
            expectFinal: opts.expectFinal,
          });
          ignoreClose = true;
          stop(undefined, result);
          client.stop();
        } catch (err) {
          ignoreClose = true;
          client.stop();
          stop(err as Error);
        }
      },
      onClose: (code, reason) => {
        if (settled || ignoreClose) {
          return;
        }
        ignoreClose = true;
        client.stop();
        stop(new Error(formatGatewayCloseError(code, reason, params.connectionDetails)));
      },
    });

    const timer = setTimeout(() => {
      ignoreClose = true;
      client.stop();
      stop(new Error(formatGatewayTimeoutError(timeoutMs, params.connectionDetails)));
    }, safeTimerTimeoutMs);

    client.start();
  });
}

async function callGatewayWithScopes<T = Record<string, unknown>>(
  opts: CallGatewayBaseOptions,
  scopes: OperatorScope[],
): Promise<T> {
  const { timeoutMs, safeTimerTimeoutMs } = resolveGatewayCallTimeout(opts.timeoutMs);
  const context = resolveGatewayCallContext(opts);
  const resolvedCredentials = await resolveGatewayCredentials(context);
  ensureExplicitGatewayAuth({
    urlOverride: context.urlOverride,
    urlOverrideSource: context.urlOverrideSource,
    explicitAuth: context.explicitAuth,
    resolvedAuth: resolvedCredentials,
    errorHint: "Fix: pass --token or --password (or gatewayToken in tools).",
    configPath: context.configPath,
  });
  ensureRemoteModeUrlConfigured(context);
  const connectionDetails = buildGatewayConnectionDetails({
    config: context.config,
    url: context.urlOverride,
    urlSource: context.urlOverrideSource,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  });
  const url = connectionDetails.url;
  const tlsFingerprint = await resolveGatewayTlsFingerprint({ opts, context, url });
  const { token, password } = resolvedCredentials;
  return await executeGatewayRequestWithScopes<T>({
    opts,
    scopes,
    url,
    token,
    password,
    tlsFingerprint,
    timeoutMs,
    safeTimerTimeoutMs,
    connectionDetails,
  });
}

export async function callGatewayScoped<T = Record<string, unknown>>(
  opts: CallGatewayScopedOptions,
): Promise<T> {
  return await callGatewayWithScopes(opts, opts.scopes);
}

export async function callGatewayCli<T = Record<string, unknown>>(
  opts: CallGatewayCliOptions,
): Promise<T> {
  const scopes = Array.isArray(opts.scopes) ? opts.scopes : CLI_DEFAULT_OPERATOR_SCOPES;
  return await callGatewayWithScopes(opts, scopes);
}

export async function callGatewayLeastPrivilege<T = Record<string, unknown>>(
  opts: CallGatewayBaseOptions,
): Promise<T> {
  const scopes = resolveLeastPrivilegeOperatorScopesForMethod(opts.method);
  return await callGatewayWithScopes(opts, scopes);
}

export async function callGateway<T = Record<string, unknown>>(
  opts: CallGatewayOptions,
): Promise<T> {
  if (Array.isArray(opts.scopes)) {
    return await callGatewayWithScopes(opts, opts.scopes);
  }
  const callerMode = opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND;
  const callerName = opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT;
  if (callerMode === GATEWAY_CLIENT_MODES.CLI || callerName === GATEWAY_CLIENT_NAMES.CLI) {
    return await callGatewayCli(opts);
  }
  return await callGatewayLeastPrivilege({
    ...opts,
    mode: callerMode,
    clientName: callerName,
  });
}

export function randomIdempotencyKey() {
  return randomUUID();
}

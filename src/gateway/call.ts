import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadConfig,
  resolveConfigPath,
  resolveGatewayPort,
  resolveStateDir,
} from "../config/config.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
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

function resolveGatewayCredentials(context: ResolvedGatewayCallContext): {
  token?: string;
  password?: string;
} {
  return resolveGatewayCredentialsFromConfig({
    cfg: context.config,
    env: process.env,
    explicitAuth: context.explicitAuth,
    urlOverride: context.urlOverride,
    urlOverrideSource: context.urlOverrideSource,
    remotePasswordPrecedence: "env-first",
  });
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
      clientVersion: opts.clientVersion ?? "dev",
      platform: opts.platform,
      mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI,
      role: "operator",
      scopes,
      deviceIdentity: loadOrCreateDeviceIdentity(),
      minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,
      maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
      onHelloOk: async () => {
        try {
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
  const resolvedCredentials = resolveGatewayCredentials(context);
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

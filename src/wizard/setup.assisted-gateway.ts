// Ensures agent-assisted setup has a reachable local Gateway before handoff.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import { resolveControlUiLinks } from "../commands/onboard-helpers.js";
import { DEFAULT_GATEWAY_PORT, resolveConfigPath } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import {
  defaultGatewayBindMode,
  isLoopbackAddress,
  resolveGatewayBindHost,
  resolveGatewayListenHosts,
} from "../gateway/net.js";
import { probeGateway, type GatewayProbeResult } from "../gateway/probe.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  findVerifiedGatewayListenerPidsOnPortSync,
  readGatewayProcessArgsSync,
} from "../infra/gateway-processes.js";
import { parsePortListenerAddress } from "../infra/ports-format.js";
import { inspectPortUsage } from "../infra/ports.js";
import { withTempWorkspace } from "../infra/private-temp-workspace.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import { attachChildProcessBridge } from "../process/child-process-bridge.js";
import { killProcessTree } from "../process/kill-tree.js";
import { spawnWithFallback } from "../process/spawn-utils.js";
import { sleep } from "../utils.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import type { GatewayWizardSettings } from "./setup.types.js";

type GatewayProbeAuth = {
  token?: string;
  password?: string;
};

export type AgentAssistedGatewayRuntime = {
  temporary: boolean;
  stop: () => Promise<void>;
};

const NOOP_GATEWAY_RUNTIME: AgentAssistedGatewayRuntime = {
  temporary: false,
  stop: async () => {},
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type GatewayConfig = NonNullable<OpenClawConfig["gateway"]>;

function resolveEffectiveGatewaySecurityPolicy(params: {
  gateway: GatewayConfig | undefined;
  authMode?: GatewayWizardSettings["authMode"];
  tailscaleMode: GatewayWizardSettings["tailscaleMode"];
}) {
  const authConfig = params.authMode
    ? { ...params.gateway?.auth, mode: params.authMode }
    : params.gateway?.auth;
  const auth = resolveGatewayAuth({
    authConfig,
    tailscaleMode: params.tailscaleMode,
  });
  const trustedProxy = auth.mode === "trusted-proxy" ? auth.trustedProxy : undefined;
  const rateLimit = authConfig?.rateLimit;
  return {
    auth: {
      mode: auth.mode,
      allowTailscale: auth.allowTailscale,
      rateLimit: {
        maxAttempts: rateLimit?.maxAttempts ?? 10,
        windowMs: rateLimit?.windowMs ?? 60_000,
        lockoutMs: rateLimit?.lockoutMs ?? 300_000,
        exemptLoopback: rateLimit?.exemptLoopback ?? true,
      },
      trustedProxy: trustedProxy
        ? {
            userHeader: trustedProxy.userHeader,
            requiredHeaders: [...(trustedProxy.requiredHeaders ?? [])].toSorted(),
            allowUsers: [...(trustedProxy.allowUsers ?? [])].toSorted(),
            allowLoopback: trustedProxy.allowLoopback === true,
          }
        : undefined,
    },
    trustedProxies: [...(params.gateway?.trustedProxies ?? [])].toSorted(),
    allowRealIpFallback: params.gateway?.allowRealIpFallback === true,
  };
}

function snapshotMatchesGatewaySettings(params: {
  configSnapshot: unknown;
  config: OpenClawConfig;
  settings: GatewayWizardSettings;
}): boolean {
  const snapshot = asRecord(params.configSnapshot);
  const config = asRecord(snapshot?.config);
  const gateway = asRecord(config?.gateway);
  const tailscale = asRecord(gateway?.tailscale);
  const tailscaleMode =
    tailscale?.mode === undefined || tailscale.mode === "off"
      ? "off"
      : tailscale.mode === "serve" || tailscale.mode === "funnel"
        ? tailscale.mode
        : undefined;
  const bind = gateway?.bind ?? defaultGatewayBindMode(tailscaleMode);
  return (
    typeof snapshot?.path === "string" &&
    path.resolve(snapshot.path) === path.resolve(resolveConfigPath()) &&
    (gateway?.port ?? DEFAULT_GATEWAY_PORT) === params.settings.port &&
    bind === params.settings.bind &&
    gateway?.customBindHost === params.settings.customBindHost &&
    tailscaleMode === params.settings.tailscaleMode &&
    isDeepStrictEqual(
      resolveEffectiveGatewaySecurityPolicy({
        gateway: gateway as GatewayConfig | undefined,
        tailscaleMode,
      }),
      resolveEffectiveGatewaySecurityPolicy({
        gateway: params.config.gateway,
        authMode: params.settings.authMode,
        tailscaleMode: params.settings.tailscaleMode,
      }),
    ) &&
    (tailscale?.resetOnExit === true) === params.settings.tailscaleResetOnExit
  );
}

function resolveGatewayProcessOptionValue(args: string[], name: string): string | null | undefined {
  let value: string | null | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      const next = args[index + 1];
      value = next && !next.startsWith("-") ? next : null;
      index += 1;
      continue;
    }
    if (arg?.startsWith(`${name}=`)) {
      value = arg.slice(name.length + 1) || null;
    }
  }
  return value;
}

function hasGatewayProcessOption(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function listenerHostMatchesExpected(host: string, expected: string): boolean {
  return (
    host === expected ||
    (expected === "127.0.0.1" && host === "localhost") ||
    (expected === "0.0.0.0" && host === "*")
  );
}

function resolvedBindHostMatchesGatewaySettings(
  bindHost: string,
  settings: GatewayWizardSettings,
): boolean {
  if (settings.bind === "loopback") {
    return isLoopbackAddress(bindHost);
  }
  if (settings.bind === "custom") {
    return bindHost === settings.customBindHost?.trim();
  }
  return true;
}

async function listenerAddressesMatchGatewaySettings(params: {
  listenerPids: number[];
  settings: GatewayWizardSettings;
}): Promise<boolean> {
  try {
    const bindHost = await resolveGatewayBindHost(
      params.settings.bind,
      params.settings.customBindHost,
    );
    if (!resolvedBindHostMatchesGatewaySettings(bindHost, params.settings)) {
      return false;
    }
    const allowedHosts = await resolveGatewayListenHosts(bindHost);
    const usage = await inspectPortUsage(params.settings.port);
    if (usage.status !== "busy" || usage.listeners.length === 0) {
      return false;
    }

    const observedPids = new Set<number>();
    let observedPrimaryHost = false;
    for (const listener of usage.listeners) {
      if (
        typeof listener.pid !== "number" ||
        !Number.isFinite(listener.pid) ||
        !params.listenerPids.includes(listener.pid) ||
        typeof listener.address !== "string"
      ) {
        return false;
      }
      const address = parsePortListenerAddress(listener.address);
      if (!address || address.port !== params.settings.port) {
        return false;
      }
      if (!allowedHosts.some((host) => listenerHostMatchesExpected(address.host, host))) {
        return false;
      }
      observedPids.add(listener.pid);
      observedPrimaryHost ||= listenerHostMatchesExpected(address.host, bindHost);
    }
    return (
      observedPrimaryHost &&
      params.listenerPids.every((listenerPid) => observedPids.has(listenerPid))
    );
  } catch {
    return false;
  }
}

async function runtimeExposureMatchesGatewaySettings(params: {
  listenerPids: number[];
  settings: GatewayWizardSettings;
}): Promise<boolean> {
  const processArgsMatch = params.listenerPids.every((pid) => {
    const args = readGatewayProcessArgsSync(pid);
    if (!args) {
      return false;
    }
    const bind = resolveGatewayProcessOptionValue(args, "--bind");
    const tailscaleMode = resolveGatewayProcessOptionValue(args, "--tailscale");
    return (
      bind !== null &&
      tailscaleMode !== null &&
      (bind === undefined || bind === params.settings.bind) &&
      (tailscaleMode === undefined || tailscaleMode === params.settings.tailscaleMode) &&
      (!hasGatewayProcessOption(args, "--tailscale-reset-on-exit") ||
        params.settings.tailscaleResetOnExit)
    );
  });
  return processArgsMatch && (await listenerAddressesMatchGatewaySettings(params));
}

function verifiedGatewayListenerStillOwnsPort(params: {
  port: number;
  listenerPids: number[];
}): boolean {
  return findVerifiedGatewayListenerPidsOnPortSync(params.port).some((pid) =>
    params.listenerPids.includes(pid),
  );
}

async function verifiedGatewayRuntimeStillMatches(params: {
  listenerPids: number[];
  settings: GatewayWizardSettings;
}): Promise<boolean> {
  return (
    verifiedGatewayListenerStillOwnsPort({
      port: params.settings.port,
      listenerPids: params.listenerPids,
    }) && (await runtimeExposureMatchesGatewaySettings(params))
  );
}

function buildInvalidProbeAuth(
  settings: GatewayWizardSettings,
  activeAuth: GatewayProbeAuth,
): GatewayProbeAuth | undefined {
  const invalidSecret = `openclaw-setup-invalid-${randomUUID()}`;
  if (settings.authMode === "token") {
    return { token: invalidSecret };
  }
  if (
    settings.authMode === "password" ||
    (settings.authMode === "trusted-proxy" && activeAuth.password)
  ) {
    return { password: invalidSecret };
  }
  return undefined;
}

function invalidAuthProbeProvesEnforcement(params: {
  settings: GatewayWizardSettings;
  probe: GatewayProbeResult;
}): boolean {
  const expectedCode =
    params.settings.authMode === "token"
      ? ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
      : params.settings.authMode === "password" || params.settings.authMode === "trusted-proxy"
        ? ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH
        : undefined;
  return (
    expectedCode !== undefined &&
    !params.probe.ok &&
    readConnectErrorDetailCode(params.probe.connectErrorDetails) === expectedCode
  );
}

function canSafelyProbeInvalidAuth(params: { url: string; config: OpenClawConfig }): boolean {
  if (params.config.gateway?.auth?.rateLimit?.exemptLoopback === false) {
    return false;
  }
  try {
    return isLoopbackAddress(new URL(params.url).hostname);
  } catch {
    return false;
  }
}

type GatewaySecurityProbeResult =
  | { ok: true }
  | {
      ok: false;
      detail?: string;
      ownershipLost?: boolean;
      retryable: boolean;
    };

async function probeGatewaySecuritySettings(params: {
  url: string;
  auth: GatewayProbeAuth;
  config: OpenClawConfig;
  settings: GatewayWizardSettings;
  listenerStillMatches: () => Promise<boolean>;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  tlsFingerprint?: string;
}): Promise<GatewaySecurityProbeResult> {
  const invalidAuth =
    params.settings.authMode !== "none" && canSafelyProbeInvalidAuth(params)
      ? buildInvalidProbeAuth(params.settings, params.auth)
      : undefined;
  if (params.settings.authMode !== "none" && !invalidAuth) {
    return {
      ok: false,
      detail: "Gateway auth enforcement cannot be probed safely.",
      retryable: false,
    };
  }
  if (!(await params.listenerStillMatches())) {
    return { ok: false, ownershipLost: true, retryable: false };
  }
  const expected = await probeGateway({
    url: params.url,
    auth: params.auth,
    timeoutMs: params.timeoutMs,
    detailLevel: "full",
    env: params.env,
    signal: params.signal,
    tlsFingerprint: params.tlsFingerprint,
  });
  if (!(await params.listenerStillMatches())) {
    return { ok: false, ownershipLost: true, retryable: false };
  }
  if (!expected.ok) {
    return { ok: false, detail: expected.error ?? undefined, retryable: true };
  }
  if (
    !snapshotMatchesGatewaySettings({
      configSnapshot: expected.configSnapshot,
      config: params.config,
      settings: params.settings,
    })
  ) {
    return {
      ok: false,
      detail: "Gateway config snapshot does not match the active setup settings.",
      retryable: false,
    };
  }
  if (!invalidAuth) {
    return { ok: true };
  }
  const invalid = await probeGateway({
    url: params.url,
    auth: invalidAuth,
    timeoutMs: params.timeoutMs,
    detailLevel: "none",
    env: params.env,
    signal: params.signal,
    tlsFingerprint: params.tlsFingerprint,
  });
  if (!(await params.listenerStillMatches())) {
    return { ok: false, ownershipLost: true, retryable: false };
  }
  return invalidAuthProbeProvesEnforcement({ settings: params.settings, probe: invalid })
    ? { ok: true }
    : {
        ok: false,
        detail: invalid.error ?? "Gateway did not reject invalid setup credentials.",
        retryable: false,
      };
}

async function probeVerifiedExistingGateway(params: {
  url: string;
  auth: GatewayProbeAuth;
  config: OpenClawConfig;
  settings: GatewayWizardSettings;
  listenerPids: number[];
  tlsFingerprint?: string;
}): Promise<boolean> {
  const listenerStillMatchesRuntime = () =>
    verifiedGatewayRuntimeStillMatches({
      settings: params.settings,
      listenerPids: params.listenerPids,
    });
  // Do not let cached device credentials prove a listener that rejects the
  // active config's shared secret.
  return await withTempWorkspace(
    { rootDir: os.tmpdir(), prefix: "openclaw-setup-gateway-probe-" },
    async (stateWorkspace) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateWorkspace.dir,
      };
      const result = await probeGatewaySecuritySettings({
        url: params.url,
        auth: params.auth,
        config: params.config,
        settings: params.settings,
        listenerStillMatches: listenerStillMatchesRuntime,
        env,
        timeoutMs: 1500,
        tlsFingerprint: params.tlsFingerprint,
      });
      return result.ok;
    },
  );
}

function collectOutputTail(child: ChildProcess): () => string {
  let tail = "";
  const append = (chunk: Buffer | string) => {
    tail = `${tail}${String(chunk)}`.slice(-4000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => tail.trim();
}

async function stopTemporaryGateway(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  killProcessTree(pid, { detached: process.platform !== "win32", graceMs: 1500 });
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    timeout.unref();
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function resolveGatewayProbeAuth(params: {
  config: OpenClawConfig;
  settings: GatewayWizardSettings;
}): Promise<GatewayProbeAuth> {
  if (params.settings.authMode === "token") {
    return { token: params.settings.gatewayToken };
  }
  if (params.settings.authMode !== "password" && params.settings.authMode !== "trusted-proxy") {
    return {};
  }
  const configuredPassword = await resolveSetupSecretInputString({
    config: params.config,
    value: params.config.gateway?.auth?.password,
    path: "gateway.auth.password",
    env: process.env,
  });
  const password = resolveGatewayAuth({
    authConfig: { ...params.config.gateway?.auth, password: configuredPassword },
    tailscaleMode: params.settings.tailscaleMode,
    env: process.env,
  }).password;
  return password ? { password } : {};
}

async function waitForOwnedGatewayListener(params: {
  port: number;
  child: ChildProcess;
  deadlineMs: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const pid = params.child.pid;
  if (!pid) {
    return { ok: false, detail: "The temporary OpenClaw Gateway process has no PID." };
  }
  const resolveExitDetail = () => {
    return params.child.exitCode !== null || params.child.signalCode !== null
      ? `The temporary OpenClaw Gateway process exited before listening on port ${params.port}.`
      : undefined;
  };
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.deadlineMs) {
    const exitDetail = resolveExitDetail();
    if (exitDetail) {
      return { ok: false, detail: exitDetail };
    }
    if (findVerifiedGatewayListenerPidsOnPortSync(params.port).includes(pid)) {
      return { ok: true };
    }
    const postCheckExitDetail = resolveExitDetail();
    if (postCheckExitDetail) {
      return { ok: false, detail: postCheckExitDetail };
    }
    await sleep(Math.max(0, Math.min(200, params.deadlineMs - (Date.now() - startedAt))));
  }
  return {
    ok: false,
    detail: `The temporary OpenClaw Gateway process is not listening on port ${params.port}.`,
  };
}

async function temporaryGatewayOwnsExpectedListeners(params: {
  settings: GatewayWizardSettings;
  child: ChildProcess;
}): Promise<boolean> {
  const pid = params.child.pid;
  if (!pid || params.child.exitCode !== null || params.child.signalCode !== null) {
    return false;
  }
  if (!findVerifiedGatewayListenerPidsOnPortSync(params.settings.port).includes(pid)) {
    return false;
  }
  return await listenerAddressesMatchGatewaySettings({
    listenerPids: [pid],
    settings: params.settings,
  });
}

function temporaryGatewayOwnershipFailureDetail(params: {
  port: number;
  child: ChildProcess;
}): string {
  return params.child.exitCode !== null || params.child.signalCode !== null
    ? `The temporary OpenClaw Gateway process exited while probing port ${params.port}.`
    : `The temporary OpenClaw Gateway process no longer owns port ${params.port}.`;
}

async function waitForOwnedGatewayReachable(params: {
  url: string;
  auth: GatewayProbeAuth;
  config: OpenClawConfig;
  port: number;
  settings: GatewayWizardSettings;
  child: ChildProcess;
  deadlineMs: number;
  tlsFingerprint?: string;
}): Promise<{ ok: boolean; detail?: string }> {
  if (!params.child.pid) {
    return { ok: false, detail: "The temporary OpenClaw Gateway process has no PID." };
  }
  const abortController = new AbortController();
  const abortProbe = () => abortController.abort();
  params.child.once("error", abortProbe);
  params.child.once("exit", abortProbe);
  const startedAt = Date.now();
  let lastDetail: string | undefined;
  try {
    return await withTempWorkspace(
      { rootDir: os.tmpdir(), prefix: "openclaw-setup-gateway-probe-" },
      async (stateWorkspace) => {
        const env = {
          ...process.env,
          OPENCLAW_STATE_DIR: stateWorkspace.dir,
        };
        const listenerStillMatches = () => temporaryGatewayOwnsExpectedListeners(params);
        while (Date.now() - startedAt < params.deadlineMs) {
          const remainingMs = params.deadlineMs - (Date.now() - startedAt);
          const probeCount = params.settings.authMode === "none" ? 1 : 2;
          const timeoutMs = Math.max(1, Math.min(1500, Math.floor(remainingMs / probeCount)));
          const result = await probeGatewaySecuritySettings({
            url: params.url,
            auth: params.auth,
            config: params.config,
            settings: params.settings,
            listenerStillMatches,
            env,
            timeoutMs,
            signal: abortController.signal,
            tlsFingerprint: params.tlsFingerprint,
          });
          if (result.ok) {
            return { ok: true };
          }
          if (result.ownershipLost) {
            return { ok: false, detail: temporaryGatewayOwnershipFailureDetail(params) };
          }
          lastDetail = result.detail;
          if (!result.retryable) {
            return { ok: false, detail: lastDetail };
          }
          const nextRemainingMs = params.deadlineMs - (Date.now() - startedAt);
          if (nextRemainingMs <= 0) {
            break;
          }
          await sleep(Math.min(400, nextRemainingMs));
        }
        return { ok: false, detail: lastDetail };
      },
    );
  } finally {
    params.child.removeListener("error", abortProbe);
    params.child.removeListener("exit", abortProbe);
  }
}

export async function ensureAgentAssistedGatewayRuntime(params: {
  config: OpenClawConfig;
  settings: GatewayWizardSettings;
  prompter: WizardPrompter;
}): Promise<AgentAssistedGatewayRuntime> {
  const links = resolveControlUiLinks({
    bind: params.settings.bind,
    port: params.settings.port,
    customBindHost: params.settings.customBindHost,
    basePath: params.config.gateway?.controlUi?.basePath,
    tlsEnabled: params.config.gateway?.tls?.enabled === true,
  });
  const tlsRuntime =
    params.config.gateway?.tls?.enabled === true
      ? await loadGatewayTlsRuntime(params.config.gateway.tls)
      : undefined;
  const tlsFingerprint = tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined;
  const auth = await resolveGatewayProbeAuth(params);
  // Assisted setup invokes the Gateway directly, so trusted-proxy mode needs
  // its documented local password fallback before the agent can use it.
  const hasDirectAuth = params.settings.authMode !== "trusted-proxy" || Boolean(auth.password);

  // Never send active Gateway credentials until the listener owner is verified.
  const existingListenerPids = findVerifiedGatewayListenerPidsOnPortSync(params.settings.port);
  if (existingListenerPids.length > 0) {
    const canVerifyExisting =
      hasDirectAuth &&
      (await runtimeExposureMatchesGatewaySettings({
        listenerPids: existingListenerPids,
        settings: params.settings,
      }));
    const existingMatches =
      canVerifyExisting &&
      (await probeVerifiedExistingGateway({
        url: links.wsUrl,
        auth,
        config: params.config,
        settings: params.settings,
        listenerPids: existingListenerPids,
        tlsFingerprint,
      }));
    if (
      existingMatches &&
      (await verifiedGatewayRuntimeStillMatches({
        settings: params.settings,
        listenerPids: existingListenerPids,
      }))
    ) {
      return NOOP_GATEWAY_RUNTIME;
    }
    throw new Error(
      `An existing Gateway is listening on port ${params.settings.port}, but setup cannot verify that it matches the active Gateway security settings. Stop the existing Gateway, then rerun onboarding.`,
    );
  }
  if (!hasDirectAuth) {
    throw new Error(
      "Agent-assisted setup requires gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD when using trusted-proxy Gateway auth so local setup tasks can authenticate. Configure a password fallback, then rerun onboarding.",
    );
  }

  const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
    port: params.settings.port,
    runtime: "node",
  });
  const [command, ...args] = programArguments;
  if (!command) {
    throw new Error("Unable to resolve the OpenClaw Gateway command.");
  }
  let child: ChildProcess;
  try {
    ({ child } = await spawnWithFallback({
      argv: [command, ...args],
      options: {
        cwd: workingDirectory,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          OPENCLAW_LOG_LEVEL: "silent",
          OPENCLAW_SERVICE_MARKER: undefined,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    }));
  } catch (error) {
    throw new Error(`Unable to start Gateway for assisted setup: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
  const outputTail = collectOutputTail(child);
  const { detach } = attachChildProcessBridge(child);
  const temporaryRuntime: AgentAssistedGatewayRuntime = {
    temporary: true,
    stop: async () => {
      detach();
      await stopTemporaryGateway(child);
    },
  };

  try {
    // A competing process can win the port bind after the initial listener check.
    const ownedReady = await waitForOwnedGatewayListener({
      port: params.settings.port,
      child,
      deadlineMs: 15_000,
    });
    const directReady = ownedReady.ok
      ? await waitForOwnedGatewayReachable({
          url: links.wsUrl,
          auth,
          config: params.config,
          port: params.settings.port,
          settings: params.settings,
          child,
          deadlineMs: 15_000,
          tlsFingerprint,
        })
      : { ok: false, detail: ownedReady.detail };
    const ready = {
      ok: ownedReady.ok && directReady.ok,
      detail: ownedReady.detail ?? directReady.detail,
    };
    if (!ready.ok) {
      const detail = outputTail() || ready.detail || "Gateway did not become reachable.";
      throw new Error(`Unable to start Gateway for assisted setup: ${formatErrorMessage(detail)}`);
    }

    await params.prompter.note(
      t("wizard.setup.agentAssistedGatewayReady"),
      t("wizard.setup.agentAssistedGatewayReadyTitle"),
    );
    return temporaryRuntime;
  } catch (error) {
    await temporaryRuntime.stop();
    throw error;
  }
}

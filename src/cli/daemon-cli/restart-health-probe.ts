import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { classifyGatewayConnectFailure } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { createConfigIO } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveReadOnlyLocalGatewayAuth } from "../../gateway/call-device-auth.js";
import { callGateway } from "../../gateway/call.js";
import { isGatewayProtocolResponseError } from "../../gateway/client.js";
import type {
  GatewayHealthReadiness,
  PluginHealthErrorSummary,
} from "../../gateway/health/types.js";
import {
  createConfiguredGatewayLocalProbe,
  type ConfiguredGatewayLocalProbe,
} from "../../gateway/local-http-probe.js";
import { READ_SCOPE } from "../../gateway/method-scopes.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../../gateway/probe-auth.js";
import {
  classifyGatewayStaleConnectionError,
  type GatewayStaleConnectionReason,
} from "../../gateway/stale-install.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { inspectPortUsage } from "../../infra/ports-inspect.js";
import { LOOPBACK_PORT_PROBE_HOSTS } from "../../infra/ports-probe.js";
import type { PortUsage } from "../../infra/ports-types.js";
import { sleep } from "../../utils.js";
import { acceptsGatewayReadiness } from "./restart-health-snapshot.js";
import type {
  GatewayPortHealthSnapshot,
  GatewayRestartHealthPurpose,
  UnavailablePluginHealthSummary,
} from "./restart-health.types.js";
import { allListenersOwnedByRuntimePid } from "./restart-port-ownership.js";

export const GATEWAY_RESTART_PROBE_TIMEOUT_MS = 3_000;

export async function readGatewayStartupPhase(params: {
  configuredProbe: ConfiguredGatewayLocalProbe;
  port: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const response = await params.configuredProbe.requestHttp({
    host: "127.0.0.1",
    pathname: "/startupz",
    port: params.port,
    timeoutMs: Math.min(
      params.timeoutMs ?? GATEWAY_RESTART_PROBE_TIMEOUT_MS,
      GATEWAY_RESTART_PROBE_TIMEOUT_MS,
    ),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (response?.statusCode !== 503) {
    return undefined;
  }
  try {
    const startup = asOptionalRecord(JSON.parse(response.body));
    return startup?.status === "starting" &&
      typeof startup.pendingReason === "string" &&
      startup.pendingReason.trim()
      ? formatGatewayRestartProbeError(startup.pendingReason)
      : undefined;
  } catch {
    return undefined;
  }
}

type GatewayRestartProbeAuth = {
  token?: string;
  password?: string;
};

export type GatewayReachability = {
  reachable: boolean;
  readiness?: GatewayHealthReadiness;
  gatewayVersion: string | null;
  gatewayBootId?: string;
  gatewayBuildId: string | null | undefined;
  activatedPluginErrors: PluginHealthErrorSummary[];
  unavailablePlugins: UnavailablePluginHealthSummary[];
  channelProbeErrors: Array<{ id: string; error: string }>;
  channelProbeTimeouts?: Array<{ id: string; error: string }>;
  probeError?: string;
  staleConnection?: GatewayStaleConnectionReason;
};

type GatewayHttpReadiness = {
  healthz: number | null;
  readyz: number | null;
};

/** Waits for the unauthenticated HTTP(S) readiness contracts reported by service start. */
export async function waitForGatewayHttpReadiness(params: {
  attempts: number;
  config?: OpenClawConfig;
  deadlineAt: number;
  delayMs: number;
  probeTimeoutMs?: number;
  port: number;
  signal?: AbortSignal;
  onObservation?: (readiness: GatewayHttpReadiness) => void;
}): Promise<GatewayHttpReadiness> {
  params.signal?.throwIfAborted();
  const probe = createConfiguredGatewayLocalProbe(params.config ?? {});
  let latest: GatewayHttpReadiness = { healthz: null, readyz: null };
  for (let attempt = 0; attempt < params.attempts; attempt += 1) {
    params.signal?.throwIfAborted();
    const remainingMs = params.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return latest;
    }
    const probeStatus = async (pathname: "/healthz" | "/readyz") => {
      const result = await probe.requestHttp({
        host: "127.0.0.1",
        pathname,
        port: params.port,
        timeoutMs: Math.min(remainingMs, params.probeTimeoutMs ?? GATEWAY_RESTART_PROBE_TIMEOUT_MS),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      return result?.statusCode ?? null;
    };
    const [healthz, readyz] = await Promise.all([probeStatus("/healthz"), probeStatus("/readyz")]);
    params.signal?.throwIfAborted();
    latest = { healthz, readyz };
    params.onObservation?.(latest);
    if (healthz === 200 && readyz === 200) {
      return latest;
    }
    if (attempt + 1 < params.attempts) {
      const remainingDelayMs = params.deadlineAt - Date.now();
      if (remainingDelayMs <= 0) {
        return latest;
      }
      await sleep(Math.min(params.delayMs, remainingDelayMs), params.signal);
    }
  }
  return latest;
}

function formatGatewayRestartProbeError(error: unknown): string {
  return truncateUtf16Safe(
    sanitizeTerminalText(redactSensitiveUrlLikeString(formatErrorMessage(error))),
    1_024,
  );
}

function isGatewayAuthRejection(reason: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(reason);
  const pairingFailure = classifyGatewayConnectFailure({ reason: normalized });
  if (
    pairingFailure.kind === "pairing-required" &&
    (normalized === "pairing required" || normalized.startsWith("pairing required:"))
  ) {
    return true;
  }
  // The restart probe runs against loopback only and only decides restart
  // liveness, not authorization. Keep this allowlist exact so a local listener
  // cannot satisfy the health check with broad device/auth-looking text.
  return (
    normalized === "auth required" ||
    normalized === "owner auth required" ||
    normalized === "connect failed" ||
    normalized === "device required" ||
    normalized.startsWith("unauthorized: gateway token missing") ||
    normalized.startsWith("unauthorized: gateway token mismatch") ||
    normalized.startsWith("unauthorized: gateway token not configured") ||
    normalized.startsWith("unauthorized: gateway password missing") ||
    normalized.startsWith("unauthorized: gateway password mismatch") ||
    normalized.startsWith("unauthorized: gateway password not configured") ||
    normalized.startsWith("unauthorized: bootstrap token invalid or expired") ||
    normalized.startsWith("unauthorized: tailscale identity missing") ||
    normalized.startsWith("unauthorized: tailscale proxy headers missing") ||
    normalized.startsWith("unauthorized: tailscale identity check failed") ||
    normalized.startsWith("unauthorized: tailscale identity mismatch") ||
    normalized.startsWith("unauthorized: too many failed authentication attempts") ||
    normalized.startsWith("unauthorized: device token mismatch") ||
    normalized.startsWith("unauthorized: device token rejected")
  );
}

function readGatewayHealthReadiness(health: unknown): GatewayHealthReadiness | undefined {
  const value = asOptionalRecord(health)?.readiness;
  // Older Gateways have no overall projection; retain their separate plugin/channel checks.
  if (value === undefined && asOptionalRecord(health)?.ok === true) {
    return undefined;
  }
  const record = asOptionalRecord(value);
  const state = record?.state;
  if (
    (state === "reachable" ||
      state === "starting" ||
      state === "ready" ||
      state === "degraded" ||
      state === "failed") &&
    Array.isArray(record?.reasons) &&
    record.reasons.every((reason) => typeof reason === "string") &&
    Array.isArray(record.warnings) &&
    record.warnings.every((reason) => typeof reason === "string")
  ) {
    return {
      state,
      reasons: record.reasons.map(formatGatewayRestartProbeError),
      warnings: record.warnings.map(formatGatewayRestartProbeError),
    };
  }
  return { state: "reachable", reasons: ["readiness-unavailable"], warnings: [] };
}

function readActivatedPluginErrors(health: unknown): PluginHealthErrorSummary[] {
  const errors = asOptionalRecord(asOptionalRecord(health)?.plugins)?.errors;
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.flatMap((value) => {
    const entry = asOptionalRecord(value);
    if (
      entry?.activated !== true ||
      typeof entry.id !== "string" ||
      typeof entry.error !== "string"
    ) {
      return [];
    }
    const error: PluginHealthErrorSummary = {
      id: entry.id,
      origin: typeof entry.origin === "string" ? entry.origin : "unknown",
      activated: true,
      error: entry.error,
    };
    for (const key of ["activationSource", "activationReason", "failurePhase"] as const) {
      if (typeof entry[key] === "string") {
        error[key] = entry[key];
      }
    }
    return [error];
  });
}

type ChannelProbeResult = { id: string; status: "unhealthy" | "timed-out"; error: string };

function readChannelProbeResults(health: unknown): ChannelProbeResult[] {
  const channels = asOptionalRecord(asOptionalRecord(health)?.channels);
  const failures = new Map<string, ChannelProbeResult>();
  for (const [channelId, value] of Object.entries(channels ?? {})) {
    const channel = asOptionalRecord(value);
    const accounts = asOptionalRecord(channel?.accounts);
    const records: Array<[string, unknown]> = [["", value], ...Object.entries(accounts ?? {})];
    for (const [accountId, accountValue] of records) {
      const account = asOptionalRecord(accountValue);
      if (
        account?.enabled === false ||
        account?.configured === false ||
        account?.linked === false
      ) {
        continue;
      }
      const probe = asOptionalRecord(account?.probe);
      if (!probe || (probe.timedOut !== true && probe.ok !== false)) {
        continue;
      }
      const id = formatGatewayRestartProbeError(
        accountId && accountId !== channel?.accountId ? channelId + "/" + accountId : channelId,
      );
      // A deadline cannot erase a definite negative from a selected or secondary account.
      const status = probe.timedOut === true ? "timed-out" : "unhealthy";
      if (!failures.has(id) || status === "unhealthy") {
        failures.set(id, {
          id,
          status,
          error: formatGatewayRestartProbeError(
            typeof probe.error === "string" && probe.error.trim() ? probe.error : "check failed",
          ),
        });
      }
    }
  }
  return [...failures.values()];
}

function readUnavailablePlugins(health: unknown): UnavailablePluginHealthSummary[] {
  const unavailable = asOptionalRecord(asOptionalRecord(health)?.plugins)?.unavailable;
  if (!Array.isArray(unavailable)) {
    return [];
  }
  return unavailable.flatMap((entry) => {
    const plugin = asOptionalRecord(entry);
    const diagnostic = asOptionalRecord(plugin?.diagnostic);
    if (
      typeof plugin?.id !== "string" ||
      plugin.state !== "configured-unavailable" ||
      diagnostic?.kind !== "plugin-verification" ||
      typeof diagnostic.reason !== "string" ||
      typeof diagnostic.detail !== "string"
    ) {
      return [];
    }
    return [{ id: plugin.id, reason: diagnostic.reason, detail: diagnostic.detail }];
  });
}

export async function confirmGatewayReachable(params: {
  port: number;
  auth?: GatewayRestartProbeAuth;
  config?: OpenClawConfig;
  configuredProbe?: ConfiguredGatewayLocalProbe;
  env?: NodeJS.ProcessEnv;
  allowDeviceIdentityRequired?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<GatewayReachability> {
  params.signal?.throwIfAborted();
  const result: GatewayReachability = {
    reachable: false,
    gatewayVersion: null,
    gatewayBuildId: undefined,
    activatedPluginErrors: [],
    unavailablePlugins: [],
    channelProbeErrors: [],
  };
  try {
    const context = params.config
      ? { config: params.config, auth: params.auth }
      : await resolveGatewayRestartProbeContext(params.env, undefined, params.signal);
    params.signal?.throwIfAborted();
    const auth = params.auth ?? context.auth;
    const configuredProbe =
      params.configuredProbe ?? createConfiguredGatewayLocalProbe(context.config);
    const target = await configuredProbe.resolveWebSocketTarget(params.port, params.signal);
    params.signal?.throwIfAborted();
    if (!target) {
      return { ...result, probeError: "gateway TLS certificate unavailable" };
    }
    const controlAuth = await resolveReadOnlyLocalGatewayAuth({
      auth,
      authNone: context.config.gateway?.auth?.mode === "none",
      env: params.env,
    });
    params.signal?.throwIfAborted();
    const health = await callGateway({
      config: context.config,
      localPortOverride: params.port,
      ...controlAuth,
      tlsFingerprint: target.tlsFingerprint,
      method: "health",
      scopes: [READ_SCOPE],
      timeoutMs: params.timeoutMs ?? GATEWAY_RESTART_PROBE_TIMEOUT_MS,
      ...(params.signal ? { signal: params.signal } : {}),
      onHelloOk: (hello) => {
        result.gatewayVersion = hello.server.version;
        result.gatewayBootId = hello.server.bootId;
        result.gatewayBuildId = hello.server.buildId ?? null;
      },
    });
    result.reachable = true;
    result.readiness = readGatewayHealthReadiness(health);
    result.activatedPluginErrors = readActivatedPluginErrors(health);
    result.unavailablePlugins = readUnavailablePlugins(health);
    const channelProbes = readChannelProbeResults(health);
    result.channelProbeErrors = channelProbes.flatMap((probe) =>
      probe.status === "unhealthy" ? [{ id: probe.id, error: probe.error }] : [],
    );
    const timeouts = channelProbes.flatMap((probe) =>
      probe.status === "timed-out" ? [{ id: probe.id, error: probe.error }] : [],
    );
    if (timeouts.length) {
      result.channelProbeTimeouts = timeouts;
    }
  } catch (error) {
    params.signal?.throwIfAborted();
    // Only a correlated Gateway rejection proves protocol reachability. Bare socket
    // closes (including foreign listeners) must never satisfy restart health.
    result.reachable =
      result.gatewayVersion === null &&
      isGatewayProtocolResponseError(error) &&
      (isGatewayAuthRejection(error.message) ||
        (params.allowDeviceIdentityRequired === true &&
          error.message === "device identity required"));
    if (result.reachable) {
      result.readiness = { state: "reachable", reasons: ["health-unavailable"], warnings: [] };
    }
    if (!result.reachable) {
      result.staleConnection = classifyGatewayStaleConnectionError(error);
      result.probeError = formatGatewayRestartProbeError(error);
    }
  }
  params.signal?.throwIfAborted();
  return result;
}

export type GatewayRestartProbeContext = {
  auth: GatewayRestartProbeAuth | undefined;
  config: OpenClawConfig;
};

export async function resolveGatewayRestartProbeContext(
  env: NodeJS.ProcessEnv | undefined,
  explicitAuth?: GatewayRestartProbeAuth,
  signal?: AbortSignal,
): Promise<GatewayRestartProbeContext> {
  signal?.throwIfAborted();
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  const cfg = await createConfigIO({
    env: mergedEnv,
    observe: false,
    pluginValidation: "skip",
    suppressFutureVersionWarning: true,
  })
    .readBestEffortConfig()
    .catch((): OpenClawConfig => ({}));
  signal?.throwIfAborted();
  const resolved = await resolveGatewayProbeAuthSafeWithSecretInputs({
    cfg,
    mode: "local",
    env: mergedEnv,
    explicitAuth,
  });
  signal?.throwIfAborted();
  return { auth: resolved.auth, config: cfg };
}

export async function inspectGatewayPortHealth(params: {
  port: number;
  auth?: GatewayRestartProbeAuth;
  config?: OpenClawConfig;
  configuredProbe?: ConfiguredGatewayLocalProbe;
  expectedListenerPid?: number;
  purpose?: GatewayRestartHealthPurpose;
  env?: NodeJS.ProcessEnv;
}): Promise<GatewayPortHealthSnapshot> {
  let portUsage: PortUsage;
  try {
    portUsage = await inspectPortUsage(params.port, {
      probeHosts: LOOPBACK_PORT_PROBE_HOSTS,
    });
  } catch (err) {
    portUsage = {
      port: params.port,
      status: "unknown",
      listeners: [],
      hints: [],
      errors: [String(err)],
    };
  }

  if (portUsage.status !== "busy") {
    return { portUsage, healthy: false };
  }
  const expectedListenerPid = params.expectedListenerPid;
  const listenerOwnershipVerified =
    expectedListenerPid !== undefined &&
    allListenersOwnedByRuntimePid(portUsage.listeners, expectedListenerPid);
  const { reachable, readiness, probeError } = await confirmGatewayReachable({
    port: params.port,
    auth: params.auth,
    ...(params.config ? { config: params.config } : {}),
    ...(params.configuredProbe ? { configuredProbe: params.configuredProbe } : {}),
    env: params.env,
    allowDeviceIdentityRequired: listenerOwnershipVerified,
  });
  return {
    portUsage,
    healthy: reachable && acceptsGatewayReadiness(readiness, params),
    ...(readiness ? { readiness } : {}),
    ...(probeError ? { probeError } : {}),
  };
}

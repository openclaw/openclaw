import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  classifyGatewayConnectFailure,
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { createConfigIO } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveReadOnlyLocalGatewayAuth } from "../../gateway/call-device-auth.js";
import { callGateway, isGatewayCredentialsRequiredError } from "../../gateway/call.js";
import { isGatewayProtocolResponseError } from "../../gateway/client.js";
import type { ExplicitGatewayAuth as GatewayRestartProbeAuth } from "../../gateway/credentials.js";
import type { PluginHealthErrorSummary } from "../../gateway/health/types.js";
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
import { isGatewayTransportError } from "../../gateway/transport-error.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { inspectPortUsage } from "../../infra/ports-inspect.js";
import { LOOPBACK_PORT_PROBE_HOSTS } from "../../infra/ports-probe.js";
import type { PortUsage } from "../../infra/ports-types.js";
import { sleep, tryParseJson } from "../../utils.js";
import type {
  GatewayPortHealthSnapshot,
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

export type GatewayReachability = {
  reachable: boolean;
  gatewayVersion: string | null;
  gatewayBootId?: string;
  gatewayBuildId: string | null | undefined;
  activatedPluginErrors: PluginHealthErrorSummary[];
  unavailablePlugins: UnavailablePluginHealthSummary[];
  channelProbeErrors: Array<{ id: string; error: string }>;
  channelProbeTimeouts?: Array<{ id: string; error: string }>;
  channelRuntimeWarnings?: Array<{ id: string; error: string }>;
  probeError?: string;
  authenticationError?: string;
  protocolMismatch?: string;
  staleConnection?: GatewayStaleConnectionReason;
};

type GatewayHttpReadiness = {
  healthz: number | null;
  readyz: number | null;
  coreReady?: boolean;
  failingChannels?: string[];
};

function readGatewayFailingChannels(response: { statusCode: number; body: string } | null) {
  const readiness = asOptionalRecord(tryParseJson(response?.body ?? ""));
  const failing = readiness?.failing;
  return response?.statusCode === 503 &&
    readiness?.ready === false &&
    readiness.coreReady === true &&
    Array.isArray(failing) &&
    failing.length > 0 &&
    failing.every((id): id is string => typeof id === "string" && id.trim().length > 0)
    ? failing
    : undefined;
}

/** Waits for the unauthenticated HTTP(S) readiness contracts reported by service start. */
export async function waitForGatewayHttpReadiness(params: {
  attempts: number;
  config?: OpenClawConfig;
  /** Absolute deadline in the performance.now() clock domain. */
  deadlineAt: number;
  delayMs: number;
  probeTimeoutMs?: number;
  port: number;
  /** Software activation may finish while a channel needs operator attention. */
  requireChannelHealth?: boolean;
  signal?: AbortSignal;
  onObservation?: (readiness: GatewayHttpReadiness) => void;
}): Promise<GatewayHttpReadiness> {
  params.signal?.throwIfAborted();
  const probe = createConfiguredGatewayLocalProbe(params.config ?? {});
  let latest: GatewayHttpReadiness = { healthz: null, readyz: null };
  for (let attempt = 0; attempt < params.attempts; attempt += 1) {
    params.signal?.throwIfAborted();
    const remainingMs = params.deadlineAt - performance.now();
    if (remainingMs <= 0) {
      return latest;
    }
    const request = (pathname: "/healthz" | "/readyz") =>
      probe.requestHttp({
        host: "127.0.0.1",
        pathname,
        port: params.port,
        timeoutMs: Math.min(remainingMs, params.probeTimeoutMs ?? GATEWAY_RESTART_PROBE_TIMEOUT_MS),
        ...(params.signal ? { signal: params.signal } : {}),
      });
    const [health, ready] = await Promise.all([request("/healthz"), request("/readyz")]);
    const healthz = health?.statusCode ?? null;
    const readyz = ready?.statusCode ?? null;
    params.signal?.throwIfAborted();
    latest = { healthz, readyz };
    if (params.requireChannelHealth === false) {
      const failingChannels = readGatewayFailingChannels(ready);
      latest.coreReady = healthz === 200 && (readyz === 200 || failingChannels !== undefined);
      if (failingChannels) {
        latest.failingChannels = failingChannels;
      }
    }
    params.onObservation?.(latest);
    if (latest.coreReady ?? (healthz === 200 && readyz === 200)) {
      return latest;
    }
    if (attempt + 1 < params.attempts) {
      const remainingDelayMs = params.deadlineAt - performance.now();
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
    normalized === "device identity required" ||
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

function isVerifiedUserRequiredResponse(error: unknown): boolean {
  // The exact close-reason allowlist does not include this sentence. The
  // structured code is the Gateway's correlated refusal, so the probe can stop.
  return (
    isGatewayProtocolResponseError(error) &&
    readConnectErrorDetailCode(error.details) ===
      ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED
  );
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
  allowHttpVerification?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  assertCurrent?: () => void;
}): Promise<GatewayReachability> {
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  const result: GatewayReachability = {
    reachable: false,
    gatewayVersion: null,
    gatewayBuildId: undefined,
    activatedPluginErrors: [],
    unavailablePlugins: [],
    channelProbeErrors: [],
  };
  let configuredProbe = params.configuredProbe;
  try {
    const context = params.config
      ? { config: params.config, auth: params.auth }
      : await resolveGatewayRestartProbeContext(params.env, undefined, params.signal);
    params.signal?.throwIfAborted();
    const auth = params.auth ?? context.auth;
    configuredProbe ??= createConfiguredGatewayLocalProbe(context.config);
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
      assertConnectionCurrent: params.assertCurrent,
      assertDispatchCurrent: params.assertCurrent,
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
    result.activatedPluginErrors = readActivatedPluginErrors(health);
    result.unavailablePlugins = readUnavailablePlugins(health);
    const errors: GatewayReachability["channelProbeErrors"] = [];
    const timeouts: GatewayReachability["channelProbeErrors"] = [];
    const warnings: GatewayReachability["channelProbeErrors"] = [];
    const channels = asOptionalRecord(asOptionalRecord(health)?.channels);
    for (const [id, summary] of Object.entries(channels ?? {})) {
      const accounts = Object.entries(asOptionalRecord(asOptionalRecord(summary)?.accounts) ?? {});
      for (const [accountId, value] of accounts.length
        ? accounts
        : Object.entries({ "": summary })) {
        const account = asOptionalRecord(value);
        if (account?.enabled === false || account?.configured === false) {
          continue;
        }
        if (account?.running === false || account?.healthState === "not-running") {
          warnings.push({
            id: accountId ? `${id}/${accountId}` : id,
            error:
              typeof account.lastError === "string" && account.lastError.trim()
                ? account.lastError
                : "not running",
          });
        }
      }
      const probe = asOptionalRecord(asOptionalRecord(summary)?.probe);
      if (!probe || (probe.timedOut !== true && probe.ok !== false)) {
        continue;
      }
      // Retain the explicit timeout marker from older Gateways that also sent ok:false.
      (probe.timedOut === true ? timeouts : errors).push({
        id,
        error: typeof probe.error === "string" && probe.error.trim() ? probe.error : "check failed",
      });
    }
    result.channelProbeErrors = errors;
    result.channelRuntimeWarnings = warnings.length ? warnings : undefined;
    if (timeouts.length) {
      result.channelProbeTimeouts = timeouts;
    }
  } catch (error) {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    const reason = isGatewayProtocolResponseError(error)
      ? error.message
      : isGatewayTransportError(error) && error.code === 1008
        ? error.reason
        : undefined;
    if (
      (reason && isGatewayAuthRejection(reason)) ||
      isGatewayCredentialsRequiredError(error) ||
      isVerifiedUserRequiredResponse(error)
    ) {
      result.authenticationError = formatGatewayRestartProbeError(reason ?? error);
    }
    // Updates verify with the previous package, so any protocol change between it and the
    // restarted Gateway rejects this handshake. HTTP identity is protocol-independent.
    if (
      isGatewayProtocolResponseError(error) &&
      readConnectErrorDetailCode(error.details) === ConnectErrorDetailCodes.PROTOCOL_MISMATCH
    ) {
      result.protocolMismatch = formatGatewayRestartProbeError(error);
    }
    // A close frame alone cannot prove a Gateway. Preserve the correlated
    // liveness contract; update verification additionally needs HTTP identity.
    result.reachable =
      result.gatewayVersion === null &&
      isGatewayProtocolResponseError(error) &&
      ((isGatewayAuthRejection(error.message) && error.message !== "device identity required") ||
        (params.allowDeviceIdentityRequired === true &&
          error.message === "device identity required"));
    if (
      (result.authenticationError || result.protocolMismatch) &&
      params.allowHttpVerification &&
      configuredProbe
    ) {
      result.reachable = false;
      const httpProbe = configuredProbe;
      const request = (pathname: "/startupz" | "/readyz") =>
        httpProbe.requestHttp({
          host: "127.0.0.1",
          port: params.port,
          pathname,
          timeoutMs: Math.min(
            params.timeoutMs ?? GATEWAY_RESTART_PROBE_TIMEOUT_MS,
            GATEWAY_RESTART_PROBE_TIMEOUT_MS,
          ),
          signal: params.signal,
        });
      const [startup, ready] = await Promise.all([request("/startupz"), request("/readyz")]);
      try {
        const identity = asOptionalRecord(JSON.parse(startup?.body ?? ""));
        const readiness = asOptionalRecord(JSON.parse(ready?.body ?? ""));
        if (
          startup?.statusCode === 200 &&
          identity?.ok === true &&
          identity.status === "started" &&
          typeof identity.version === "string" &&
          identity.version.trim()
        ) {
          result.gatewayVersion = identity.version;
          result.gatewayBuildId =
            typeof identity.buildId === "string" ? identity.buildId : undefined;
          const failingChannels = readGatewayFailingChannels(ready);
          result.reachable =
            (ready?.statusCode === 200 && readiness?.ready === true) ||
            failingChannels !== undefined;
          if (failingChannels) {
            result.channelRuntimeWarnings = failingChannels.map((id) => ({
              id,
              error: "channel readiness unavailable",
            }));
          }
        }
      } catch {
        // Older or non-Gateway HTTP listeners cannot supply candidate identity.
      }
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
  config?: OpenClawConfig,
): Promise<GatewayRestartProbeContext> {
  signal?.throwIfAborted();
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  const cfg =
    config ??
    (await createConfigIO({
      env: mergedEnv,
      observe: false,
      pluginValidation: "skip",
      suppressFutureVersionWarning: true,
    })
      .readBestEffortConfig()
      .catch((): OpenClawConfig => ({})));
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
  /** Command-owned cancellation for the in-flight listener probe. */
  signal?: AbortSignal;
}): Promise<GatewayPortHealthSnapshot> {
  params.signal?.throwIfAborted();
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

  params.signal?.throwIfAborted();
  if (portUsage.status !== "busy") {
    return { portUsage, healthy: false };
  }
  const expectedListenerPid = params.expectedListenerPid;
  const listenerOwnershipVerified =
    expectedListenerPid !== undefined &&
    allListenersOwnedByRuntimePid(portUsage.listeners, expectedListenerPid);
  const { reachable, probeError } = await confirmGatewayReachable({
    port: params.port,
    auth: params.auth,
    ...(params.config ? { config: params.config } : {}),
    ...(params.configuredProbe ? { configuredProbe: params.configuredProbe } : {}),
    env: process.env,
    allowDeviceIdentityRequired: listenerOwnershipVerified,
    signal: params.signal,
  });
  return { portUsage, healthy: reachable, ...(probeError ? { probeError } : {}) };
}

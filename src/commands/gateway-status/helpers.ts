import { parseTimeoutMsWithFallback } from "../../cli/parse-timeout.js";
import { resolveGatewayPort } from "../../config/config.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../../config/types.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { readGatewayPasswordEnv, readGatewayTokenEnv } from "../../gateway/credentials.js";
import type { GatewayProbeResult } from "../../gateway/probe.js";
import { resolveConfiguredSecretInputString } from "../../gateway/resolve-configured-secret-input-string.js";
import { pickPrimaryTailnetIPv4 } from "../../infra/tailnet.js";
import { colorize, theme } from "../../terminal/theme.js";
import { pickGatewaySelfPresence } from "../gateway-presence.js";

const MISSING_SCOPE_PATTERN = /\bmissing scope:\s*[a-z0-9._-]+/i;

type TargetKind = "explicit" | "configRemote" | "localLoopback" | "sshTunnel";

const INACTIVE_LOOPBACK_PROBE_BUDGET_MS = 800;
const REMOTE_PROBE_BUDGET_MS = 1_500;
const SSH_TUNNEL_PROBE_BUDGET_MS = 2_000;

export type GatewayStatusTarget = {
  id: string;
  kind: TargetKind;
  url: string;
  active: boolean;
  tunnel?: {
    kind: "ssh";
    target: string;
    localPort: number;
    remotePort: number;
    pid: number | null;
  };
};

export type GatewayConfigSummary = {
  path: string | null;
  exists: boolean;
  valid: boolean;
  issues: Array<{ path: string; message: string }>;
  legacyIssues: Array<{ path: string; message: string }>;
  gateway: {
    mode: string | null;
    bind: string | null;
    port: number | null;
    controlUiEnabled: boolean | null;
    controlUiBasePath: string | null;
    authMode: string | null;
    authTokenConfigured: boolean;
    authPasswordConfigured: boolean;
    remoteUrl: string | null;
    remoteTokenConfigured: boolean;
    remotePasswordConfigured: boolean;
    tailscaleMode: string | null;
  };
  discovery: {
    wideAreaEnabled: boolean | null;
  };
};

function parseIntOrNull(value: unknown): number | null {
  const s =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : "";
  if (!s) {
    return null;
  }
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseTimeoutMs(raw: unknown, fallbackMs: number): number {
  return parseTimeoutMsWithFallback(raw, fallbackMs);
}

function normalizeWsUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
    return null;
  }
  return trimmed;
}

export function resolveTargets(cfg: OpenClawConfig, explicitUrl?: string): GatewayStatusTarget[] {
  const targets: GatewayStatusTarget[] = [];
  const add = (t: GatewayStatusTarget) => {
    if (!targets.some((x) => x.url === t.url)) {
      targets.push(t);
    }
  };

  const explicit = typeof explicitUrl === "string" ? normalizeWsUrl(explicitUrl) : null;
  if (explicit) {
    add({ id: "explicit", kind: "explicit", url: explicit, active: true });
  }

  const remoteUrl =
    typeof cfg.gateway?.remote?.url === "string" ? normalizeWsUrl(cfg.gateway.remote.url) : null;
  if (remoteUrl) {
    add({
      id: "configRemote",
      kind: "configRemote",
      url: remoteUrl,
      active: cfg.gateway?.mode === "remote",
    });
  }

  const port = resolveGatewayPort(cfg);
  add({
    id: "localLoopback",
    kind: "localLoopback",
    url: `ws://127.0.0.1:${port}`,
    active: cfg.gateway?.mode !== "remote",
  });

  return targets;
}

export function resolveProbeBudgetMs(
  overallMs: number,
  target: Pick<GatewayStatusTarget, "kind" | "active">,
): number {
  switch (target.kind) {
    case "localLoopback":
      // Active loopback probes should honor the caller budget because local shells/containers
      // can legitimately take longer to connect. Inactive loopback probes stay bounded so
      // remote-mode status checks do not stall on an expected local miss.
      return target.active ? overallMs : Math.min(INACTIVE_LOOPBACK_PROBE_BUDGET_MS, overallMs);
    case "sshTunnel":
      return Math.min(SSH_TUNNEL_PROBE_BUDGET_MS, overallMs);
    default:
      return Math.min(REMOTE_PROBE_BUDGET_MS, overallMs);
  }
}

export function sanitizeSshTarget(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^ssh\\s+/, "");
}

export async function resolveAuthForTarget(
  cfg: OpenClawConfig,
  target: GatewayStatusTarget,
  overrides: { token?: string; password?: string },
): Promise<{ token?: string; password?: string; diagnostics?: string[] }> {
  const tokenOverride = overrides.token?.trim() ? overrides.token.trim() : undefined;
  const passwordOverride = overrides.password?.trim() ? overrides.password.trim() : undefined;
  if (tokenOverride || passwordOverride) {
    return { token: tokenOverride, password: passwordOverride };
  }

  const diagnostics: string[] = [];
  const authMode = cfg.gateway?.auth?.mode;
  const tokenOnly = authMode === "token";
  const passwordOnly = authMode === "password";

  const resolveToken = async (value: unknown, path: string): Promise<string | undefined> => {
    const tokenResolution = await resolveConfiguredSecretInputString({
      config: cfg,
      env: process.env,
      value,
      path,
      unresolvedReasonStyle: "detailed",
    });
    if (tokenResolution.unresolvedRefReason) {
      diagnostics.push(tokenResolution.unresolvedRefReason);
    }
    return tokenResolution.value;
  };
  const resolvePassword = async (value: unknown, path: string): Promise<string | undefined> => {
    const passwordResolution = await resolveConfiguredSecretInputString({
      config: cfg,
      env: process.env,
      value,
      path,
      unresolvedReasonStyle: "detailed",
    });
    if (passwordResolution.unresolvedRefReason) {
      diagnostics.push(passwordResolution.unresolvedRefReason);
    }
    return passwordResolution.value;
  };
  const withDiagnostics = <T extends { token?: string; password?: string }>(result: T) =>
    diagnostics.length > 0 ? { ...result, diagnostics } : result;

  if (target.kind === "configRemote" || target.kind === "sshTunnel") {
    const remoteTokenValue = cfg.gateway?.remote?.token;
    const remotePasswordValue = (cfg.gateway?.remote as { password?: unknown } | undefined)
      ?.password;
    const token = await resolveToken(remoteTokenValue, "gateway.remote.token");
    const password = token
      ? undefined
      : await resolvePassword(remotePasswordValue, "gateway.remote.password");
    return withDiagnostics({ token, password });
  }

  const authDisabled = authMode === "none" || authMode === "trusted-proxy";
  if (authDisabled) {
    return {};
  }

  const envToken = readGatewayTokenEnv();
  const envPassword = readGatewayPasswordEnv();
  if (tokenOnly) {
    const token = await resolveToken(cfg.gateway?.auth?.token, "gateway.auth.token");
    if (token) {
      return withDiagnostics({ token });
    }
    if (envToken) {
      return { token: envToken };
    }
    return withDiagnostics({});
  }
  if (passwordOnly) {
    const password = await resolvePassword(cfg.gateway?.auth?.password, "gateway.auth.password");
    if (password) {
      return withDiagnostics({ password });
    }
    if (envPassword) {
      return { password: envPassword };
    }
    return withDiagnostics({});
  }

  const token = await resolveToken(cfg.gateway?.auth?.token, "gateway.auth.token");
  if (token) {
    return withDiagnostics({ token });
  }
  if (envToken) {
    return { token: envToken };
  }
  if (envPassword) {
    return withDiagnostics({ password: envPassword });
  }
  const password = await resolvePassword(cfg.gateway?.auth?.password, "gateway.auth.password");

  return withDiagnostics({ token, password });
}

export { pickGatewaySelfPresence };

export function extractConfigSummary(snapshotUnknown: unknown): GatewayConfigSummary {
  const snap = snapshotUnknown as Partial<ConfigFileSnapshot> | null;
  const path = typeof snap?.path === "string" ? snap.path : null;
  const exists = Boolean(snap?.exists);
  const valid = Boolean(snap?.valid);
  const issuesRaw = Array.isArray(snap?.issues) ? snap.issues : [];
  const legacyRaw = Array.isArray(snap?.legacyIssues) ? snap.legacyIssues : [];

  const cfg = (snap?.config ?? {}) as Record<string, unknown>;
  const gateway = (cfg.gateway ?? {}) as Record<string, unknown>;
  const secrets = (cfg.secrets ?? {}) as Record<string, unknown>;
  const secretDefaults = (secrets.defaults ?? undefined) as
    | { env?: string; file?: string; exec?: string }
    | undefined;
  const discovery = (cfg.discovery ?? {}) as Record<string, unknown>;
  const wideArea = (discovery.wideArea ?? {}) as Record<string, unknown>;

  const remote = (gateway.remote ?? {}) as Record<string, unknown>;
  const auth = (gateway.auth ?? {}) as Record<string, unknown>;
  const controlUi = (gateway.controlUi ?? {}) as Record<string, unknown>;
  const tailscale = (gateway.tailscale ?? {}) as Record<string, unknown>;

  const authMode = typeof auth.mode === "string" ? auth.mode : null;
  const authTokenConfigured = hasConfiguredSecretInput(auth.token, secretDefaults);
  const authPasswordConfigured = hasConfiguredSecretInput(auth.password, secretDefaults);

  const remoteUrl = typeof remote.url === "string" ? normalizeWsUrl(remote.url) : null;
  const remoteTokenConfigured = hasConfiguredSecretInput(remote.token, secretDefaults);
  const remotePasswordConfigured = hasConfiguredSecretInput(remote.password, secretDefaults);

  const wideAreaEnabled = typeof wideArea.enabled === "boolean" ? wideArea.enabled : null;

  return {
    path,
    exists,
    valid,
    issues: issuesRaw
      .filter((i): i is { path: string; message: string } =>
        Boolean(i && typeof i.path === "string" && typeof i.message === "string"),
      )
      .map((i) => ({ path: i.path, message: i.message })),
    legacyIssues: legacyRaw
      .filter((i): i is { path: string; message: string } =>
        Boolean(i && typeof i.path === "string" && typeof i.message === "string"),
      )
      .map((i) => ({ path: i.path, message: i.message })),
    gateway: {
      mode: typeof gateway.mode === "string" ? gateway.mode : null,
      bind: typeof gateway.bind === "string" ? gateway.bind : null,
      port: parseIntOrNull(gateway.port),
      controlUiEnabled: typeof controlUi.enabled === "boolean" ? controlUi.enabled : null,
      controlUiBasePath: typeof controlUi.basePath === "string" ? controlUi.basePath : null,
      authMode,
      authTokenConfigured,
      authPasswordConfigured,
      remoteUrl,
      remoteTokenConfigured,
      remotePasswordConfigured,
      tailscaleMode: typeof tailscale.mode === "string" ? tailscale.mode : null,
    },
    discovery: { wideAreaEnabled },
  };
}

export function buildNetworkHints(cfg: OpenClawConfig) {
  const tailnetIPv4 = pickPrimaryTailnetIPv4();
  const port = resolveGatewayPort(cfg);
  return {
    localLoopbackUrl: `ws://127.0.0.1:${port}`,
    localTailnetUrl: tailnetIPv4 ? `ws://${tailnetIPv4}:${port}` : null,
    tailnetIPv4: tailnetIPv4 ?? null,
  };
}

export function renderTargetHeader(target: GatewayStatusTarget, rich: boolean) {
  const kindLabel =
    target.kind === "localLoopback"
      ? "Local loopback"
      : target.kind === "sshTunnel"
        ? "Remote over SSH"
        : target.kind === "configRemote"
          ? target.active
            ? "Remote (configured)"
            : "Remote (configured, inactive)"
          : "URL (explicit)";
  return `${colorize(rich, theme.heading, kindLabel)} ${colorize(rich, theme.muted, target.url)}`;
}

export function isScopeLimitedProbeFailure(probe: GatewayProbeResult): boolean {
  if (probe.ok || probe.connectLatencyMs == null) {
    return false;
  }
  return MISSING_SCOPE_PATTERN.test(probe.error ?? "");
}

export function isProbeReachable(probe: GatewayProbeResult): boolean {
  return probe.ok || isScopeLimitedProbeFailure(probe);
}

export function renderProbeSummaryLine(probe: GatewayProbeResult, rich: boolean) {
  if (probe.ok) {
    const latency =
      typeof probe.connectLatencyMs === "number" ? `${probe.connectLatencyMs}ms` : "unknown";
    return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${colorize(rich, theme.success, "RPC: ok")}`;
  }

  const detail = probe.error ? ` - ${probe.error}` : "";
  if (probe.connectLatencyMs != null) {
    const latency =
      typeof probe.connectLatencyMs === "number" ? `${probe.connectLatencyMs}ms` : "unknown";
    const rpcStatus = isScopeLimitedProbeFailure(probe)
      ? colorize(rich, theme.warn, "RPC: limited")
      : colorize(rich, theme.error, "RPC: failed");
    return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${rpcStatus}${detail}`;
  }

  return `${colorize(rich, theme.error, "Connect: failed")}${detail}`;
}

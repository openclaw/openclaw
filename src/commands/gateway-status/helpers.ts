import { resolveGatewayPort } from "../../config/config.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../../config/types.js";
import { hasConfiguredSecretInput, resolveSecretInputRef } from "../../config/types.secrets.js";
import type { GatewayProbeResult } from "../../gateway/probe.js";
import { pickPrimaryTailnetIPv4 } from "../../infra/tailnet.js";
import { secretRefKey } from "../../secrets/ref-contract.js";
import { resolveSecretRefValues } from "../../secrets/resolve.js";
import { colorize, theme } from "../../terminal/theme.js";
import { pickGatewaySelfPresence } from "../gateway-presence.js";

type TargetKind = "explicit" | "configRemote" | "localLoopback" | "sshTunnel";

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
  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" || typeof raw === "bigint"
        ? String(raw)
        : "";
  if (!value) {
    return fallbackMs;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid --timeout: ${value}`);
  }
  return parsed;
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

export function resolveProbeBudgetMs(overallMs: number, kind: TargetKind): number {
  if (kind === "localLoopback") {
    return Math.min(800, overallMs);
  }
  if (kind === "sshTunnel") {
    return Math.min(2000, overallMs);
  }
  return Math.min(1500, overallMs);
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

async function resolveConfiguredSecretInputValue(
  cfg: OpenClawConfig,
  value: unknown,
  path: string,
): Promise<{ value?: string; unresolvedRefReason?: string }> {
  const { ref } = resolveSecretInputRef({
    value,
    defaults: cfg.secrets?.defaults,
  });
  if (ref) {
    try {
      const resolved = await resolveSecretRefValues([ref], {
        config: cfg,
        env: process.env,
      });
      const resolvedValue = resolved.get(secretRefKey(ref));
      if (typeof resolvedValue !== "string") {
        return { unresolvedRefReason: `${path} SecretRef resolved to a non-string value.` };
      }
      const trimmed = resolvedValue.trim();
      if (trimmed.length === 0) {
        return { unresolvedRefReason: `${path} SecretRef resolved to an empty value.` };
      }
      return { value: trimmed };
    } catch (err) {
      return { unresolvedRefReason: `${path} SecretRef is unresolved (${String(err)}).` };
    }
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return { value: trimmed.length > 0 ? trimmed : undefined };
  }
  return {};
}

function readGatewayTokenEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env.OPENCLAW_GATEWAY_TOKEN?.trim() || env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  return token || undefined;
}

function readGatewayPasswordEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const password = env.OPENCLAW_GATEWAY_PASSWORD?.trim() || env.CLAWDBOT_GATEWAY_PASSWORD?.trim();
  return password || undefined;
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
    const tokenResolution = await resolveConfiguredSecretInputValue(cfg, value, path);
    if (tokenResolution.unresolvedRefReason) {
      diagnostics.push(tokenResolution.unresolvedRefReason);
    }
    return tokenResolution.value;
  };
  const resolvePassword = async (value: unknown, path: string): Promise<string | undefined> => {
    const passwordResolution = await resolveConfiguredSecretInputValue(cfg, value, path);
    if (passwordResolution.unresolvedRefReason) {
      diagnostics.push(passwordResolution.unresolvedRefReason);
    }
    return passwordResolution.value;
  };

  if (target.kind === "configRemote" || target.kind === "sshTunnel") {
    const remoteTokenValue = cfg.gateway?.remote?.token;
    const remotePasswordValue = (cfg.gateway?.remote as { password?: unknown } | undefined)
      ?.password;
    const token = await resolveToken(remoteTokenValue, "gateway.remote.token");
    const password = token
      ? undefined
      : await resolvePassword(remotePasswordValue, "gateway.remote.password");
    return {
      token,
      password,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }

  const authDisabled = authMode === "none" || authMode === "trusted-proxy";
  if (authDisabled) {
    return {};
  }

  const envToken = readGatewayTokenEnv();
  const envPassword = readGatewayPasswordEnv();
  if (tokenOnly) {
    if (envToken) {
      return { token: envToken };
    }
    const token = await resolveToken(cfg.gateway?.auth?.token, "gateway.auth.token");
    return {
      token,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }
  if (passwordOnly) {
    if (envPassword) {
      return { password: envPassword };
    }
    const password = await resolvePassword(cfg.gateway?.auth?.password, "gateway.auth.password");
    return {
      password,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }

  if (envToken) {
    return { token: envToken };
  }
  const token = await resolveToken(cfg.gateway?.auth?.token, "gateway.auth.token");
  if (token) {
    return {
      token,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }
  if (envPassword) {
    return {
      password: envPassword,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }
  const password = await resolvePassword(cfg.gateway?.auth?.password, "gateway.auth.password");

  return {
    token,
    password,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
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
    return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${colorize(rich, theme.error, "RPC: failed")}${detail}`;
  }

  return `${colorize(rich, theme.error, "Connect: failed")}${detail}`;
}

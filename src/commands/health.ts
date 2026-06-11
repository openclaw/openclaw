/** Collects and renders gateway health for channels, agents, plugins, and sessions. */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { styleHealthChannelLine } from "../../packages/terminal-core/src/health-style.js";
import { isRich } from "../../packages/terminal-core/src/theme.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { inspectChannelAccount } from "../channels/account-inspection.js";
import {
  resolveChannelAccountConfigured,
  resolveChannelAccountEnabled,
} from "../channels/account-summary.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { buildChannelAccountSnapshotFromAccount } from "../channels/plugins/status.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import { probeGatewayStatus } from "../cli/daemon-cli/probe.js";
import { withProgress } from "../cli/progress.js";
import type { RuntimeConfigSnapshotMetadata } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listContextEngineQuarantines } from "../context-engine/registry.js";
import {
  buildGatewayConnectionDetails,
  buildGatewayProbeConnectionDetails,
  callGateway,
  formatGatewayTransportErrorJson,
  isGatewayCredentialsRequiredError,
} from "../gateway/call.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
} from "../gateway/channel-health-policy.js";
import { getGatewayModelPricingHealth } from "../gateway/model-pricing-cache-state.js";
import { isGatewayModelPricingEnabled } from "../gateway/model-pricing-config.js";
import type { ChannelRuntimeSnapshot } from "../gateway/server-channel-runtime.types.js";
import { info } from "../globals.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { buildChannelAccountBindings, resolvePreferredAccountId } from "../routing/bindings.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  buildCredentialsRequiredHealthDiagnostic,
  GATEWAY_HEALTH_REACHABLE_LINE,
  gatewayProbeResultSawGateway,
} from "./gateway-health-auth-diagnostic.js";
import { formatHealthChannelLines } from "./health-format.js";
import type {
  AgentHealthSummary,
  ChannelAccountHealthSummary,
  ChannelHealthSummary,
  ContextEngineHealthSummary,
  HealthSummary,
  PluginHealthErrorSummary,
  PluginHealthSummary,
  RuntimeConfigHealthSummary,
} from "./health.types.js";
import { logGatewayConnectionDetails } from "./status.gateway-connection.js";
export { formatHealthChannelLines } from "./health-format.js";
export type {
  AgentHealthSummary,
  ChannelAccountHealthSummary,
  ChannelHealthSummary,
  HealthSummary,
} from "./health.types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

const debugHealth = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_HEALTH)) {
    console.warn("[health:debug]", ...args);
  }
};

const loadConfigRuntime = async () => await import("../config/config.js");

const PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR =
  "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.";

const redactIMessageProbeErrorMessage = (message: string): string => {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replaceAll(
    /\/Users\/[^/\s]+\/Library\/Messages\/chat\.db/g,
    "~/Library/Messages/chat.db",
  );
};

const buildNonSensitiveProbeFailure = (
  channelId: string,
  probe: unknown,
): Record<string, unknown> | undefined => {
  const record = asNullableRecord(probe);
  if (channelId !== "imessage" || !record || record.ok !== false) {
    return undefined;
  }
  if (typeof record.error !== "string") {
    return undefined;
  }

  // Preserve the actionable Full Disk Access failure while stripping the local
  // username path before health leaves the gateway.
  const error = redactIMessageProbeErrorMessage(record.error);
  if (
    !/\bimsg\b/i.test(error) ||
    !error.includes("~/Library/Messages/chat.db") ||
    !/\bFull Disk Access\b/i.test(error)
  ) {
    return undefined;
  }
  return { ok: false, error: PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR };
};

const formatDurationParts = (ms: number): string => {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  const units: Array<{ label: string; size: number }> = [
    { label: "w", size: 7 * 24 * 60 * 60 * 1000 },
    { label: "d", size: 24 * 60 * 60 * 1000 },
    { label: "h", size: 60 * 60 * 1000 },
    { label: "m", size: 60 * 1000 },
    { label: "s", size: 1000 },
  ];
  let remaining = Math.max(0, Math.floor(ms));
  const parts: string[] = [];
  for (const unit of units) {
    const value = Math.floor(remaining / unit.size);
    if (value > 0) {
      parts.push(`${value}${unit.label}`);
      remaining -= value * unit.size;
    }
  }
  if (parts.length === 0) {
    return "0s";
  }
  return parts.join(" ");
};

function formatEventLoopHealthLine(summary: HealthSummary): string | null {
  const eventLoop = summary.eventLoop;
  if (!eventLoop) {
    return null;
  }
  const state = eventLoop.degraded ? "degraded" : "ok";
  const reasons = eventLoop.reasons.length > 0 ? ` reasons=${eventLoop.reasons.join(",")}` : "";
  return `Gateway event loop: ${state}${reasons} max=${Math.round(
    eventLoop.delayMaxMs,
  )}ms p99=${Math.round(eventLoop.delayP99Ms)}ms util=${eventLoop.utilization} cpu=${
    eventLoop.cpuCoreRatio
  }`;
}

/** Formats optional model-pricing cache degradation for text health output. */
export function formatModelPricingHealthLine(summary: HealthSummary): string | null {
  const modelPricing = summary.modelPricing;
  if (!modelPricing || modelPricing.state === "disabled") {
    return null;
  }
  if (modelPricing.state === "ok") {
    return null;
  }
  const detail = modelPricing.detail ? ` (${modelPricing.detail})` : "";
  return `Model pricing: warning (optional pricing refresh degraded)${detail}`;
}

const RUNTIME_CONFIG_DRIFT_PATHS = [
  "agents.defaults.model",
  "agents.defaults.models",
  "agents.list",
  "models",
  "gateway.auth",
  "auth.profiles",
  "auth.order",
  "secrets.providers",
] as const;

type RuntimeHealthConfigState = {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig | null;
  metadata: RuntimeConfigSnapshotMetadata | null;
  diskSourceConfig: OpenClawConfig | null;
  diskReadError?: string;
  hashConfigValue: (config: OpenClawConfig) => string;
};

function stableHealthValueStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableHealthValueStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableHealthValueStringify(record[key])}`)
    .join(",")}}`;
}

function readConfigPathValue(config: OpenClawConfig, path: string): unknown {
  let current: unknown = config;
  for (const part of path.split(".")) {
    const record = asNullableRecord(current);
    if (!record || !Object.hasOwn(record, part)) {
      return undefined;
    }
    current = record[part];
  }
  return current;
}

function readPrimaryModelLabel(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  const record = asNullableRecord(value);
  const primary = record?.primary;
  return typeof primary === "string" && primary.trim() ? primary.trim() : null;
}

function resolveDefaultModelLabel(config: OpenClawConfig): string | null {
  const agents = asNullableRecord(config.agents);
  const defaults = asNullableRecord(agents?.defaults);
  return readPrimaryModelLabel(defaults?.model) ?? readPrimaryModelLabel(defaults?.models);
}

function listRuntimeConfigDriftPaths(params: {
  liveSourceConfig: OpenClawConfig;
  diskSourceConfig: OpenClawConfig;
}): string[] {
  const driftPaths: string[] = [];
  for (const path of RUNTIME_CONFIG_DRIFT_PATHS) {
    const liveValue = readConfigPathValue(params.liveSourceConfig, path);
    const diskValue = readConfigPathValue(params.diskSourceConfig, path);
    if (stableHealthValueStringify(liveValue) !== stableHealthValueStringify(diskValue)) {
      driftPaths.push(path);
    }
  }
  return driftPaths;
}

/**
 * Builds the runtime-config drift summary surfaced by `openclaw health`.
 *
 * Fingerprint values (`liveSourceFingerprint`, `diskSourceFingerprint`) are
 * defense-in-depth gated behind an explicit `includeFingerprints` flag and
 * default to omitted. Today the only caller is the gateway-auth-gated
 * `openclaw health` CLI summary path, so leaving them off in the default
 * shape keeps any future non-admin consumer (for example a richer probe
 * endpoint, or a Control UI badge added later) from accidentally leaking
 * config fingerprints without an explicit decision at the call site.
 *
 * `state` plus `driftPaths` plus the resolved `liveDefaultModel` /
 * `diskDefaultModel` labels are enough for an operator to see and act on
 * drift; the fingerprints are only useful when an operator wants to
 * cross-reference logs.
 */
function buildRuntimeConfigHealthSummary(
  state: RuntimeHealthConfigState,
  opts: { includeFingerprints?: boolean } = {},
): RuntimeConfigHealthSummary | undefined {
  const includeFingerprints = opts.includeFingerprints === true;
  const liveSourceConfig = state.sourceConfig;
  if (!liveSourceConfig) {
    return state.metadata
      ? {
          state: "unknown",
          ...(includeFingerprints
            ? { liveSourceFingerprint: state.metadata.sourceFingerprint }
            : {}),
          message: "Runtime source config snapshot is unavailable.",
        }
      : undefined;
  }
  if (!state.diskSourceConfig) {
    // The disk-read error string can include a filesystem path
    // (`snapshot.path`) or a JSON-parse error excerpt. Non-admin callers see
    // `openclaw health` through the `operator.read` scope, so the detailed
    // disk message is gated behind `includeFingerprints` (admin-only) and a
    // generic message is returned for non-sensitive snapshots to keep the
    // operator's filesystem layout and parse-error excerpts inside the
    // gateway-auth boundary.
    const detailedMessage = state.diskReadError
      ? `Could not read disk config source snapshot: ${state.diskReadError}`
      : "Disk config source snapshot is unavailable.";
    return {
      state: "unknown",
      ...(includeFingerprints
        ? {
            liveSourceFingerprint:
              state.metadata?.sourceFingerprint ?? state.hashConfigValue(liveSourceConfig),
          }
        : {}),
      liveDefaultModel: resolveDefaultModelLabel(liveSourceConfig),
      message: includeFingerprints
        ? detailedMessage
        : "Disk config source snapshot is unavailable.",
    };
  }
  const driftPaths = listRuntimeConfigDriftPaths({
    liveSourceConfig,
    diskSourceConfig: state.diskSourceConfig,
  });
  const liveDefaultModel = resolveDefaultModelLabel(liveSourceConfig);
  const diskDefaultModel = resolveDefaultModelLabel(state.diskSourceConfig);
  return {
    state: driftPaths.length > 0 ? "drift" : "ok",
    ...(includeFingerprints
      ? {
          liveSourceFingerprint:
            state.metadata?.sourceFingerprint ?? state.hashConfigValue(liveSourceConfig),
          diskSourceFingerprint: state.hashConfigValue(state.diskSourceConfig),
        }
      : {}),
    liveDefaultModel,
    diskDefaultModel,
    ...(driftPaths.length > 0
      ? {
          driftPaths,
          message:
            "Live gateway runtime config differs from disk for model/provider/auth paths; restart is required or pending.",
        }
      : {}),
  };
}

export function formatRuntimeConfigHealthLine(summary: HealthSummary): string | null {
  const runtimeConfig = summary.runtimeConfig;
  if (!runtimeConfig) {
    return null;
  }
  if (runtimeConfig.state === "drift") {
    const paths = runtimeConfig.driftPaths?.length
      ? runtimeConfig.driftPaths.join(", ")
      : "model/provider/auth config";
    const modelDetail =
      runtimeConfig.liveDefaultModel || runtimeConfig.diskDefaultModel
        ? `; live=${runtimeConfig.liveDefaultModel ?? "unknown"} disk=${
            runtimeConfig.diskDefaultModel ?? "unknown"
          }`
        : "";
    return `Runtime config: warning (live gateway differs from disk for ${paths}; restart required or pending${modelDetail})`;
  }
  if (runtimeConfig.state === "unknown") {
    // Render the unknown state so a missing/invalid/unreadable disk config
    // surfaces in normal text `openclaw health` output. Without this, the
    // drift detector returns `state: "unknown"` in JSON but the text
    // formatter silently drops the diagnostic exactly when operators most
    // need to know the disk side cannot be compared.
    const reason = runtimeConfig.message?.trim() || "disk source unavailable";
    return `Runtime config: warning (unknown disk source: ${reason})`;
  }
  return null;
}

function buildContextEngineHealthSummary(): ContextEngineHealthSummary | undefined {
  const quarantined: ContextEngineHealthSummary["quarantined"] = [];
  for (const entry of listContextEngineQuarantines()) {
    const summary: ContextEngineHealthSummary["quarantined"][number] = {
      engineId: entry.engineId,
      operation: entry.operation,
      reason: entry.reason,
      failedAt: entry.failedAt.getTime(),
    };
    if (entry.owner) {
      summary.owner = entry.owner;
    }
    quarantined.push(summary);
  }
  return quarantined.length > 0 ? { quarantined } : undefined;
}

/** Formats context engine quarantine state for text health output. */
export function formatContextEngineHealthLine(summary: HealthSummary): string | null {
  const quarantined = summary.contextEngines?.quarantined ?? [];
  if (quarantined.length === 0) {
    return null;
  }
  const engines = quarantined.map((entry) => entry.engineId).join(", ");
  return `Context engine: warning (${quarantined.length} quarantined; downgraded to legacy: ${engines})`;
}

const resolveHeartbeatSummary = (cfg: OpenClawConfig, agentId: string) =>
  resolveHeartbeatSummaryForAgent(cfg, agentId);

const resolveAgentOrder = (cfg: OpenClawConfig) => {
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const entries = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const seen = new Set<string>();
  const ordered: Array<{ id: string; name?: string }> = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      continue;
    }
    const id = normalizeAgentId(entry.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ordered.push({ id, name: typeof entry.name === "string" ? entry.name : undefined });
  }

  if (!seen.has(defaultAgentId)) {
    ordered.unshift({ id: defaultAgentId });
  }

  if (ordered.length === 0) {
    ordered.push({ id: defaultAgentId });
  }

  return { defaultAgentId, ordered };
};

const buildSessionSummary = async (storePath: string) => {
  const { loadSessionStore } = await import("../config/sessions/store.js");
  const store = loadSessionStore(storePath, { clone: false });
  const sessions = Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .map(([key, entry]) => ({ key, updatedAt: entry?.updatedAt ?? 0 }))
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  const recent = sessions.slice(0, 5).map((s) => ({
    key: s.key,
    updatedAt: s.updatedAt || null,
    age: s.updatedAt ? Date.now() - s.updatedAt : null,
  }));
  return {
    path: storePath,
    count: sessions.length,
    recent,
  } satisfies HealthSummary["sessions"];
};

function buildPluginHealthSummary(): PluginHealthSummary | undefined {
  const registry = getActivePluginRegistry();
  if (!registry) {
    return undefined;
  }
  const loaded = registry.plugins
    .filter((plugin) => plugin.status === "loaded")
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  const errors = registry.plugins
    .filter((plugin) => plugin.status === "error")
    .map((plugin) => {
      const error: PluginHealthErrorSummary = {
        id: plugin.id,
        origin: plugin.origin,
        activated: plugin.activated === true,
        error: plugin.error ?? "unknown plugin load error",
      };
      if (plugin.activationSource) {
        error.activationSource = plugin.activationSource;
      }
      if (plugin.activationReason) {
        error.activationReason = plugin.activationReason;
      }
      if (plugin.failurePhase) {
        error.failurePhase = plugin.failurePhase;
      }
      return error;
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
  if (loaded.length === 0 && errors.length === 0) {
    return undefined;
  }
  return { loaded, errors };
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  const record = asNullableRecord(value);
  if (!record) {
    return undefined;
  }
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

const hasAccountValue = (account: unknown): boolean => account !== null && account !== undefined;

function resolveProbeAccountEnabled(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
  account: unknown;
  diagnostics: string[];
}): boolean {
  const fallback = readBooleanField(params.account, "enabled") ?? true;
  try {
    return resolveChannelAccountEnabled({
      plugin: params.plugin,
      account: params.account,
      cfg: params.cfg,
    });
  } catch (error) {
    params.diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to evaluate enabled state (${formatErrorMessage(error)}).`,
    );
    return fallback;
  }
}

async function resolveProbeAccountConfigured(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
  account: unknown;
  diagnostics: string[];
}): Promise<boolean> {
  const fallback = readBooleanField(params.account, "configured") ?? true;
  try {
    return await resolveChannelAccountConfigured({
      plugin: params.plugin,
      account: params.account,
      cfg: params.cfg,
      readAccountConfiguredField: true,
    });
  } catch (error) {
    params.diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to evaluate configured state (${formatErrorMessage(error)}).`,
    );
    return fallback;
  }
}

async function resolveHealthAccountContext(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): Promise<{
  probeAccount: unknown;
  snapshotAccount: unknown;
  enabled: boolean;
  configured: boolean;
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  let account: unknown;
  try {
    account = params.plugin.config.resolveAccount(params.cfg, params.accountId);
  } catch (error) {
    diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to resolve account (${formatErrorMessage(error)}).`,
    );
  }
  let inspectedAccount: unknown;
  try {
    inspectedAccount = await inspectChannelAccount(params);
  } catch (error) {
    diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to inspect account (${formatErrorMessage(error)}).`,
    );
  }

  const probeAccount = hasAccountValue(account) ? account : inspectedAccount;
  if (!hasAccountValue(probeAccount)) {
    return {
      probeAccount: {},
      snapshotAccount: {},
      enabled: false,
      configured: false,
      diagnostics,
    };
  }
  const snapshotAccount = hasAccountValue(inspectedAccount) ? inspectedAccount : probeAccount;

  const enabled = resolveProbeAccountEnabled({
    plugin: params.plugin,
    cfg: params.cfg,
    accountId: params.accountId,
    account: probeAccount,
    diagnostics,
  });
  const configured = await resolveProbeAccountConfigured({
    plugin: params.plugin,
    cfg: params.cfg,
    accountId: params.accountId,
    account: probeAccount,
    diagnostics,
  });

  return {
    probeAccount,
    snapshotAccount,
    enabled,
    configured,
    diagnostics,
  };
}

/** Builds the gateway-side health snapshot for channels, agents, plugins, and sessions. */
export async function getHealthSnapshot(params?: {
  timeoutMs?: number;
  probe?: boolean;
  includeSensitive?: boolean;
  runtimeSnapshot?: ChannelRuntimeSnapshot;
  eventLoop?: HealthSummary["eventLoop"];
}): Promise<HealthSummary> {
  const timeoutMs = params?.timeoutMs;
  const runtimeConfigState = await readRuntimeHealthConfigState();
  const cfg = runtimeConfigState.config;
  const { defaultAgentId, ordered } = resolveAgentOrder(cfg);
  const channelBindings = buildChannelAccountBindings(cfg);
  const sessionCache = new Map<string, HealthSummary["sessions"]>();
  const agents: AgentHealthSummary[] = [];
  for (const entry of ordered) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
    const sessions = sessionCache.get(storePath) ?? (await buildSessionSummary(storePath));
    sessionCache.set(storePath, sessions);
    agents.push({
      agentId: entry.id,
      name: entry.name,
      isDefault: entry.id === defaultAgentId,
      heartbeat: resolveHeartbeatSummary(cfg, entry.id),
      sessions,
    });
  }
  const defaultAgent = agents.find((agent) => agent.isDefault) ?? agents[0];
  const heartbeatSeconds = defaultAgent?.heartbeat.everyMs
    ? Math.round(defaultAgent.heartbeat.everyMs / 1000)
    : 0;
  const sessions =
    defaultAgent?.sessions ??
    (await buildSessionSummary(resolveStorePath(cfg.session?.store, { agentId: defaultAgentId })));

  const start = Date.now();
  const cappedTimeout = resolveTimerTimeoutMs(timeoutMs, DEFAULT_TIMEOUT_MS, 50);
  const doProbe = params?.probe !== false;
  const includeSensitive = params?.includeSensitive !== false;
  const channels: Record<string, ChannelHealthSummary> = {};
  const plugins = listReadOnlyChannelPluginsForConfig(cfg, {
    includeSetupFallbackPlugins: false,
  });
  const channelOrder = plugins.map((plugin) => plugin.id);
  const channelLabels: Record<string, string> = {};

  for (const plugin of plugins) {
    channelLabels[plugin.id] = plugin.meta.label ?? plugin.id;
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg,
      accountIds,
    });
    const boundAccounts = channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [];
    const preferredAccountId = resolvePreferredAccountId({
      accountIds,
      defaultAccountId,
      boundAccounts,
    });
    const boundAccountIdsAll = Array.from(
      new Set(Array.from(channelBindings.get(plugin.id)?.values() ?? []).flat()),
    );
    const accountIdsToProbe = Array.from(
      new Set(
        [preferredAccountId, defaultAccountId, ...accountIds, ...boundAccountIdsAll].filter(
          (value) => value && value.trim(),
        ),
      ),
    );
    // Probe preferred/default/bound accounts first, but include all configured
    // accounts so verbose health can explain account-specific failures.
    debugHealth("channel", {
      id: plugin.id,
      accountIds,
      defaultAccountId,
      boundAccounts,
      preferredAccountId,
      accountIdsToProbe,
    });
    const accountSummaries: Record<string, ChannelAccountHealthSummary> = {};

    for (const accountId of accountIdsToProbe) {
      const { probeAccount, snapshotAccount, enabled, configured, diagnostics } =
        await resolveHealthAccountContext({
          plugin,
          cfg,
          accountId,
        });
      if (diagnostics.length > 0) {
        debugHealth("account.diagnostics", { channel: plugin.id, accountId, diagnostics });
      }

      let probe: unknown;
      let lastProbeAt: number | null = null;
      if (enabled && configured && doProbe && plugin.status?.probeAccount) {
        try {
          probe = await plugin.status.probeAccount({
            account: probeAccount,
            timeoutMs: cappedTimeout,
            cfg,
          });
          lastProbeAt = Date.now();
        } catch (err) {
          probe = { ok: false, error: formatErrorMessage(err) };
          lastProbeAt = Date.now();
        }
      }

      const probeRecord =
        probe && typeof probe === "object" ? (probe as Record<string, unknown>) : null;
      const bot =
        probeRecord && typeof probeRecord.bot === "object"
          ? (probeRecord.bot as { username?: string | null })
          : null;
      if (bot?.username) {
        debugHealth("probe.bot", { channel: plugin.id, accountId, username: bot.username });
      }

      const runtimeSnapshot =
        params?.runtimeSnapshot?.channelAccounts[plugin.id]?.[accountId] ??
        (accountId === defaultAccountId ? params?.runtimeSnapshot?.channels[plugin.id] : undefined);
      const nonSensitiveProbeFailure = buildNonSensitiveProbeFailure(plugin.id, probe);
      const snapshotProbe = includeSensitive ? probe : nonSensitiveProbeFailure;
      const snapshot: ChannelAccountSnapshot = await buildChannelAccountSnapshotFromAccount({
        plugin,
        cfg,
        accountId,
        account: snapshotAccount,
        runtime: runtimeSnapshot,
        probe: snapshotProbe,
        enabledFallback: enabled,
        configuredFallback: configured,
      });
      if (lastProbeAt) {
        snapshot.lastProbeAt = lastProbeAt;
      }
      const health = evaluateChannelHealth(snapshot, {
        channelId: plugin.id,
        now: Date.now(),
        staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
        channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
      });
      if (!health.healthy) {
        snapshot.healthState = health.reason;
      }

      const summary = plugin.status?.buildChannelSummary
        ? await plugin.status.buildChannelSummary({
            account: probeAccount,
            cfg,
            defaultAccountId: accountId,
            snapshot,
          })
        : undefined;
      const record =
        summary && typeof summary === "object"
          ? ({ ...snapshot, ...summary } as ChannelAccountHealthSummary)
          : ({
              ...snapshot,
              accountId,
              configured,
            } satisfies ChannelAccountHealthSummary);
      if (record.configured === undefined) {
        record.configured = configured;
      }
      if (includeSensitive && record.probe === undefined && probe !== undefined) {
        record.probe = probe;
      }
      if (!includeSensitive) {
        const summaryProbeFailure = buildNonSensitiveProbeFailure(plugin.id, record.probe);
        const safeProbeFailure = summaryProbeFailure ?? nonSensitiveProbeFailure;
        if (safeProbeFailure) {
          record.probe = safeProbeFailure;
        } else {
          delete record.probe;
        }
      }
      if (record.lastProbeAt === undefined && lastProbeAt) {
        record.lastProbeAt = lastProbeAt;
      }
      record.accountId = accountId;
      accountSummaries[accountId] = record;
    }

    const defaultSummary =
      accountSummaries[preferredAccountId] ??
      accountSummaries[defaultAccountId] ??
      accountSummaries[accountIdsToProbe[0] ?? preferredAccountId];
    const fallbackSummary = defaultSummary ?? accountSummaries[Object.keys(accountSummaries)[0]];
    if (fallbackSummary) {
      channels[plugin.id] = {
        ...fallbackSummary,
        accounts: accountSummaries,
      } satisfies ChannelHealthSummary;
    }
  }

  const pluginHealth = buildPluginHealthSummary();
  const contextEngineHealth = buildContextEngineHealthSummary();
  // Thread the existing `includeSensitive` decision through to runtime-config
  // fingerprints. Sensitive snapshots (the admin `openclaw health` CLI path)
  // get them for operator log correlation; non-sensitive snapshots -- which
  // include the cached `healthCache`, the `broadcastHealthUpdate` payload, and
  // any non-admin probe response derived from this builder -- omit them so the
  // deterministic live/disk fingerprint values stay inside the gateway-auth
  // boundary.
  const runtimeConfigHealth = buildRuntimeConfigHealthSummary(runtimeConfigState, {
    includeFingerprints: includeSensitive,
  });
  const summary: HealthSummary = {
    ok: true,
    ts: Date.now(),
    durationMs: Date.now() - start,
    ...(params?.eventLoop ? { eventLoop: params.eventLoop } : {}),
    ...(pluginHealth ? { plugins: pluginHealth } : {}),
    ...(contextEngineHealth ? { contextEngines: contextEngineHealth } : {}),
    modelPricing: getGatewayModelPricingHealth({ enabled: isGatewayModelPricingEnabled(cfg) }),
    ...(runtimeConfigHealth ? { runtimeConfig: runtimeConfigHealth } : {}),
    channels,
    channelOrder,
    channelLabels,
    heartbeatSeconds,
    defaultAgentId,
    agents,
    sessions: {
      path: sessions.path,
      count: sessions.count,
      recent: sessions.recent,
    },
  };

  return summary;
}

/** Runs the `openclaw health` command against the gateway and renders JSON or text. */
export async function healthCommand(
  opts: {
    json?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
    config?: OpenClawConfig;
    token?: string;
    password?: string;
  },
  runtime: RuntimeEnv,
) {
  const cfg = opts.config ?? (await readBestEffortHealthConfig());
  // Always query the running gateway; do not open a direct Baileys socket here.
  let summary: HealthSummary;
  try {
    summary = await withProgress(
      {
        label: "Checking gateway health…",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway<HealthSummary>({
          method: "health",
          params: opts.verbose ? { probe: true } : undefined,
          timeoutMs: opts.timeoutMs,
          config: cfg,
          token: opts.token,
          password: opts.password,
        }),
    );
  } catch (error) {
    if (isGatewayCredentialsRequiredError(error)) {
      const details = await buildGatewayProbeConnectionDetails({
        config: cfg,
        token: opts.token,
        password: opts.password,
      });
      const probe = await probeGatewayStatus({
        url: details.url,
        token: opts.token,
        password: opts.password,
        tlsFingerprint: details.tlsFingerprint,
        preauthHandshakeTimeoutMs: details.preauthHandshakeTimeoutMs,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        config: cfg,
        json: opts.json,
      });
      if (gatewayProbeResultSawGateway(probe)) {
        const diagnostic = buildCredentialsRequiredHealthDiagnostic();
        if (opts.json) {
          writeRuntimeJson(runtime, diagnostic);
          runtime.exit(1);
          return;
        }
        runtime.log(GATEWAY_HEALTH_REACHABLE_LINE);
        runtime.log(diagnostic.error.message);
        runtime.exit(1);
        return;
      }
      throw error;
    }
    if (opts.json) {
      const payload = formatGatewayTransportErrorJson(error);
      if (payload) {
        writeRuntimeJson(runtime, payload);
        runtime.exit(1);
        return;
      }
    }
    throw error;
  }
  // Gateway reachability defines success; channel issues are reported but not fatal here.
  const fatal = false;

  if (opts.json) {
    writeRuntimeJson(runtime, summary);
  } else {
    const debugEnabled = isTruthyEnvValue(process.env.OPENCLAW_DEBUG_HEALTH);
    const rich = isRich();
    if (opts.verbose) {
      const details = buildGatewayConnectionDetails({ config: cfg });
      logGatewayConnectionDetails({
        runtime,
        info,
        message: details.message,
      });
    }
    const localAgents = resolveAgentOrder(cfg);
    const defaultAgentId = summary.defaultAgentId ?? localAgents.defaultAgentId;
    const agents = Array.isArray(summary.agents) ? summary.agents : [];
    const resolvedAgents =
      agents.length > 0
        ? agents
        : await Promise.all(
            localAgents.ordered.map(async (entry) => {
              const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
              return {
                agentId: entry.id,
                name: entry.name,
                isDefault: entry.id === localAgents.defaultAgentId,
                heartbeat: resolveHeartbeatSummary(cfg, entry.id),
                sessions: await buildSessionSummary(storePath),
              } satisfies AgentHealthSummary;
            }),
          );
    const displayAgents = opts.verbose
      ? resolvedAgents
      : resolvedAgents.filter((agent) => agent.agentId === defaultAgentId);
    const channelBindings = buildChannelAccountBindings(cfg);
    const displayPlugins = listReadOnlyChannelPluginsForConfig(cfg, {
      includeSetupFallbackPlugins: false,
    });
    if (debugEnabled) {
      runtime.log(info("[debug] local channel accounts"));
      for (const plugin of displayPlugins) {
        const accountIds = plugin.config.listAccountIds(cfg);
        const defaultAccountId = resolveChannelDefaultAccountId({
          plugin,
          cfg,
          accountIds,
        });
        runtime.log(
          `  ${plugin.id}: accounts=${accountIds.join(", ") || "(none)"} default=${defaultAccountId}`,
        );
        for (const accountId of accountIds) {
          const { snapshotAccount, configured, diagnostics } = await resolveHealthAccountContext({
            plugin,
            cfg,
            accountId,
          });
          const record = asNullableRecord(snapshotAccount);
          const tokenSource =
            record && typeof record.tokenSource === "string" ? record.tokenSource : undefined;
          runtime.log(
            `    - ${accountId}: configured=${configured}${tokenSource ? ` tokenSource=${tokenSource}` : ""}`,
          );
          for (const diagnostic of diagnostics) {
            runtime.log(`      ! ${diagnostic}`);
          }
        }
      }
      runtime.log(info("[debug] bindings map"));
      for (const [channelId, byAgent] of channelBindings.entries()) {
        const entries = Array.from(byAgent.entries()).map(
          ([agentId, ids]) => `${agentId}=[${ids.join(", ")}]`,
        );
        runtime.log(`  ${channelId}: ${entries.join(" ")}`);
      }
      runtime.log(info("[debug] gateway channel probes"));
      for (const [channelId, channelSummary] of Object.entries(summary.channels ?? {})) {
        const accounts = channelSummary.accounts ?? {};
        const probes = Object.entries(accounts).map(([accountId, accountSummary]) => {
          const probe = asNullableRecord(accountSummary.probe);
          const bot = probe ? asNullableRecord(probe.bot) : null;
          const username = bot && typeof bot.username === "string" ? bot.username : null;
          return `${accountId}=${username ?? "(no bot)"}`;
        });
        runtime.log(`  ${channelId}: ${probes.join(", ") || "(none)"}`);
      }
    }
    const channelAccountFallbacks = Object.fromEntries(
      displayPlugins.map((plugin) => {
        const accountIds = plugin.config.listAccountIds(cfg);
        const defaultAccountId = resolveChannelDefaultAccountId({
          plugin,
          cfg,
          accountIds,
        });
        const preferred = resolvePreferredAccountId({
          accountIds,
          defaultAccountId,
          boundAccounts: channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [],
        });
        return [plugin.id, [preferred] as string[]] as const;
      }),
    );
    const accountIdsByChannel = (() => {
      const entries = displayAgents.length > 0 ? displayAgents : resolvedAgents;
      const byChannel: Record<string, string[]> = {};
      for (const [channelId, byAgent] of channelBindings.entries()) {
        const accountIds: string[] = [];
        for (const agent of entries) {
          const ids = byAgent.get(agent.agentId) ?? [];
          for (const id of ids) {
            if (!accountIds.includes(id)) {
              accountIds.push(id);
            }
          }
        }
        if (accountIds.length > 0) {
          byChannel[channelId] = accountIds;
        }
      }
      for (const [channelId, fallbackIds] of Object.entries(channelAccountFallbacks)) {
        if (!byChannel[channelId] || byChannel[channelId].length === 0) {
          byChannel[channelId] = fallbackIds;
        }
      }
      return byChannel;
    })();
    const channelLines =
      Object.keys(accountIdsByChannel).length > 0
        ? formatHealthChannelLines(summary, {
            accountMode: opts.verbose ? "all" : "default",
            accountIdsByChannel,
          })
        : formatHealthChannelLines(summary, {
            accountMode: opts.verbose ? "all" : "default",
          });
    for (const line of channelLines) {
      runtime.log(styleHealthChannelLine(line, rich));
    }
    const eventLoopLine = formatEventLoopHealthLine(summary);
    if (eventLoopLine) {
      runtime.log(styleHealthChannelLine(eventLoopLine, rich));
    }
    const modelPricingLine = formatModelPricingHealthLine(summary);
    if (modelPricingLine) {
      runtime.log(styleHealthChannelLine(modelPricingLine, rich));
    }
    const runtimeConfigLine = formatRuntimeConfigHealthLine(summary);
    if (runtimeConfigLine) {
      runtime.log(styleHealthChannelLine(runtimeConfigLine, rich));
    }
    const contextEngineLine = formatContextEngineHealthLine(summary);
    if (contextEngineLine) {
      runtime.log(styleHealthChannelLine(contextEngineLine, rich));
    }
    for (const plugin of displayPlugins) {
      const channelSummary = summary.channels?.[plugin.id];
      if (!channelSummary || channelSummary.linked !== true) {
        continue;
      }
      if (!plugin.status?.logSelfId) {
        continue;
      }
      const boundAccounts = channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [];
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accountId = resolvePreferredAccountId({
        accountIds,
        defaultAccountId,
        boundAccounts,
      });
      const accountContext = await resolveHealthAccountContext({
        plugin,
        cfg,
        accountId,
      });
      if (!accountContext.enabled || !accountContext.configured) {
        continue;
      }
      if (accountContext.diagnostics.length > 0) {
        continue;
      }
      try {
        plugin.status.logSelfId({
          account: accountContext.probeAccount,
          cfg,
          runtime,
          includeChannelPrefix: true,
        });
      } catch (error) {
        debugHealth("logSelfId.failed", {
          channel: plugin.id,
          accountId,
          error: formatErrorMessage(error),
        });
      }
    }

    if (resolvedAgents.length > 0) {
      const agentLabels = resolvedAgents.map((agent) =>
        agent.isDefault ? `${agent.agentId} (default)` : agent.agentId,
      );
      runtime.log(info(`Agents: ${agentLabels.join(", ")}`));
    }
    const heartbeatParts = displayAgents
      .map((agent) => {
        const everyMs = agent.heartbeat?.everyMs;
        const label = everyMs ? formatDurationParts(everyMs) : "disabled";
        return `${label} (${agent.agentId})`;
      })
      .filter(Boolean);
    if (heartbeatParts.length > 0) {
      runtime.log(info(`Heartbeat interval: ${heartbeatParts.join(", ")}`));
    }
    if (displayAgents.length === 0) {
      runtime.log(
        info(`Session store: ${summary.sessions.path} (${summary.sessions.count} entries)`),
      );
      if (summary.sessions.recent.length > 0) {
        for (const r of summary.sessions.recent) {
          runtime.log(
            `- ${r.key} (${r.updatedAt ? `${Math.round((Date.now() - r.updatedAt) / 60000)}m ago` : "no activity"})`,
          );
        }
      }
    } else {
      for (const agent of displayAgents) {
        runtime.log(
          info(
            `Session store (${agent.agentId}): ${agent.sessions.path} (${agent.sessions.count} entries)`,
          ),
        );
        if (agent.sessions.recent.length > 0) {
          for (const r of agent.sessions.recent) {
            runtime.log(
              `- ${r.key} (${r.updatedAt ? `${Math.round((Date.now() - r.updatedAt) / 60000)}m ago` : "no activity"})`,
            );
          }
        }
      }
    }
  }

  if (fatal) {
    runtime.exit(1);
  }
}

async function readBestEffortHealthConfig(): Promise<OpenClawConfig> {
  const { readBestEffortConfig } = await loadConfigRuntime();
  return await readBestEffortConfig();
}

async function readRuntimeHealthConfigState(): Promise<RuntimeHealthConfigState> {
  const configRuntime = await loadConfigRuntime();
  const config = configRuntime.getRuntimeConfig();
  let diskSourceConfig: OpenClawConfig | null = null;
  let diskReadError: string | undefined;
  // Distinguish "valid empty config on disk" from "couldn't read or parse".
  // `readSourceConfigBestEffort` returns `{}` for both the missing-file and
  // parse-failure cases, which would otherwise feed into the drift comparison
  // and report `state: "drift"` with restart-required wording even though
  // the disk side is actually unknown/invalid. Use the richer snapshot reader
  // and only treat the parsed `sourceConfig` as comparable when both `exists`
  // and `valid` are true; otherwise propagate an explicit diskReadError so
  // `buildRuntimeConfigHealthSummary` returns `state: "unknown"` with the
  // right operator-facing message.
  try {
    const snapshot = await configRuntime.readSourceConfigSnapshot();
    if (!snapshot.exists) {
      diskReadError = `Disk config file not found at ${snapshot.path}.`;
    } else if (!snapshot.valid) {
      const issueDetail = snapshot.issues.length > 0 ? `: ${snapshot.issues[0]?.message}` : "";
      diskReadError = `Disk config is invalid${issueDetail}`;
    } else {
      diskSourceConfig = snapshot.sourceConfig as OpenClawConfig;
    }
  } catch (error) {
    diskReadError = formatErrorMessage(error);
  }
  return {
    config,
    sourceConfig: configRuntime.getRuntimeConfigSourceSnapshot(),
    metadata: configRuntime.getRuntimeConfigSnapshotMetadata(),
    diskSourceConfig,
    ...(diskReadError ? { diskReadError } : {}),
    hashConfigValue: configRuntime.hashRuntimeConfigValue,
  };
}

// Doctor gateway memory-status surface: eligibility, dreaming config, and embedding probe.
import { expectDefined } from "@openclaw/normalization-core";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  AgentSelectionRequiredError,
  tryResolveAmbientOwnerAgentId,
} from "../../agents/agent-scope-config.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveMemoryDeepDreamingConfig,
  resolveMemoryLightDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingWorkspaces,
  resolveMemoryRemDreamingConfig,
  type ShortTermDreamingStats,
  type ShortTermDreamingStatsEntry,
} from "../../memory-host-sdk/dreaming.js";
import type * as defaultMemoryCoreRuntime from "../../plugin-sdk/memory-core-bundled-runtime.js";
import { loadPluginManifestRegistryCore } from "../../plugins/manifest-registry.js";
import {
  getActiveMemorySearchManagerCore,
  resolveMemoryRuntimePluginIds,
} from "../../plugins/memory-runtime.js";
import { hasKind, resolveSlotSelection } from "../../plugins/slots.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { formatError } from "../server-utils.js";
import type { GatewayRequestContext, GatewayRequestHandler, RespondFn } from "./types.js";

type DoctorMemoryStatusCoreRuntime = Pick<
  typeof defaultMemoryCoreRuntime,
  "loadShortTermPromotionDreamingStats"
>;

const MANAGED_DEEP_SLEEP_CRON_NAME = "Memory Dreaming Promotion";
const MANAGED_DEEP_SLEEP_CRON_TAG = "[managed-by=memory-core.short-term-promotion]";
const DEEP_SLEEP_SYSTEM_EVENT_TEXT = "__openclaw_memory_core_short_term_promotion_dream__";

type DoctorMemoryDreamingPhasePayload = {
  enabled: boolean;
  cron: string;
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

type DoctorMemoryLightDreamingPayload = DoctorMemoryDreamingPhasePayload & {
  lookbackDays: number;
  limit: number;
};

type DoctorMemoryDeepDreamingPayload = DoctorMemoryDreamingPhasePayload & {
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays: number;
  maxAgeDays?: number;
  limit: number;
};

type DoctorMemoryRemDreamingPayload = DoctorMemoryDreamingPhasePayload & {
  lookbackDays: number;
  limit: number;
  minPatternStrength: number;
};

type DreamingStoreStats = Omit<ShortTermDreamingStats, "storePath" | "phaseSignalPath"> & {
  storePath?: string;
  phaseSignalPath?: string;
  storeError?: string;
};

type DoctorMemoryDreamingConfigPayload = {
  enabled: boolean;
  timezone?: string;
  verboseLogging: boolean;
  storageMode: "inline" | "separate" | "both";
  separateReports: boolean;
  shortTermEntries: ShortTermDreamingStatsEntry[];
  signalEntries: ShortTermDreamingStatsEntry[];
  promotedEntries: ShortTermDreamingStatsEntry[];
  phases: {
    light: DoctorMemoryLightDreamingPayload;
    deep: DoctorMemoryDeepDreamingPayload;
    rem: DoctorMemoryRemDreamingPayload;
  };
};

type DoctorMemoryDreamingPayload = DoctorMemoryDreamingConfigPayload & DreamingStoreStats;

export type DoctorMemoryStatusPayload = {
  agentId: string;
  eligible: boolean;
  eligibilityReason?: string;
  /**
   * The selected slot owner registered a host memory capability. Independent of search support.
   * Deliberately not "any loaded memory plugin": dreaming keeps an unselected sidecar in scope, and
   * reporting its registration here names the owner for a capability the owner never registered.
   */
  capabilityRegistered: boolean;
  /** The owner's capability declares a search runtime. `capability.runtime` is optional. */
  searchRuntimeRegistered: boolean;
  /** The selected slot owner's own load failed; the loader records this instead of throwing. */
  ownerLoadFailed: boolean;
  provider?: string;
  embedding: {
    ok: boolean;
    error?: string;
    checked?: boolean;
    cached?: boolean;
    checkedAtMs?: number;
    cacheExpiresAtMs?: number;
  };
  embeddingRuntime?: DoctorMemoryEmbeddingRuntimePayload;
  dreaming?: DoctorMemoryDreamingPayload;
};

export type DoctorMemoryEmbeddingRuntimePayload = {
  engine: "llama.cpp";
  state: "ready" | "failed";
  backend?: "metal" | "cpu";
  buildInfo?: string;
  model?: { id: string; path?: string };
  capabilities?: { vision: boolean; draft: boolean };
  endpoints?: Record<string, "ready" | "unavailable">;
  loadError?: string;
};

function resolveDreamingConfig(cfg: OpenClawConfig): DoctorMemoryDreamingConfigPayload {
  const resolved = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
    cfg,
  });
  const light = resolveMemoryLightDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
    cfg,
  });
  const deep = resolveMemoryDeepDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
    cfg,
  });
  const rem = resolveMemoryRemDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
    cfg,
  });
  return {
    enabled: resolved.enabled,
    ...(resolved.timezone ? { timezone: resolved.timezone } : {}),
    verboseLogging: resolved.verboseLogging,
    storageMode: resolved.storage.mode,
    separateReports: resolved.storage.separateReports,
    shortTermEntries: [],
    signalEntries: [],
    promotedEntries: [],
    phases: {
      light: {
        enabled: light.enabled,
        cron: light.cron,
        lookbackDays: light.lookbackDays,
        limit: light.limit,
        managedCronPresent: false,
      },
      deep: {
        enabled: deep.enabled,
        cron: deep.cron,
        limit: deep.limit,
        minScore: deep.minScore,
        minRecallCount: deep.minRecallCount,
        minUniqueQueries: deep.minUniqueQueries,
        recencyHalfLifeDays: deep.recencyHalfLifeDays,
        managedCronPresent: false,
        ...(typeof deep.maxAgeDays === "number" ? { maxAgeDays: deep.maxAgeDays } : {}),
      },
      rem: {
        enabled: rem.enabled,
        cron: rem.cron,
        lookbackDays: rem.lookbackDays,
        limit: rem.limit,
        minPatternStrength: rem.minPatternStrength,
        managedCronPresent: false,
      },
    },
  };
}

const DREAMING_ENTRY_LIST_LIMIT = 8;

// Keep malformed persisted timestamps behind valid entries; returning NaN here
// makes Array.sort preserve arbitrary input order and can hide valid diagnostics.
function parseDreamingTimestampMs(value: string | undefined): number {
  return parseDateStringTimestampMs(value) ?? Number.NEGATIVE_INFINITY;
}

function compareDreamingEntryByRecency(
  a: ShortTermDreamingStatsEntry,
  b: ShortTermDreamingStatsEntry,
): number {
  const aMs = parseDreamingTimestampMs(a.lastRecalledAt);
  const bMs = parseDreamingTimestampMs(b.lastRecalledAt);
  if (bMs !== aMs) {
    return bMs > aMs ? 1 : -1;
  }
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  return a.path.localeCompare(b.path);
}

function compareDreamingEntryBySignals(
  a: ShortTermDreamingStatsEntry,
  b: ShortTermDreamingStatsEntry,
): number {
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  if (b.phaseHitCount !== a.phaseHitCount) {
    return b.phaseHitCount - a.phaseHitCount;
  }
  return compareDreamingEntryByRecency(a, b);
}

function compareDreamingEntryByPromotion(
  a: ShortTermDreamingStatsEntry,
  b: ShortTermDreamingStatsEntry,
): number {
  const aMs = parseDreamingTimestampMs(a.promotedAt);
  const bMs = parseDreamingTimestampMs(b.promotedAt);
  if (bMs !== aMs) {
    return bMs > aMs ? 1 : -1;
  }
  return compareDreamingEntryBySignals(a, b);
}

function trimDreamingEntries(
  entries: ShortTermDreamingStatsEntry[],
  compare: (a: ShortTermDreamingStatsEntry, b: ShortTermDreamingStatsEntry) => number,
): ShortTermDreamingStatsEntry[] {
  const selected: ShortTermDreamingStatsEntry[] = [];
  for (const entry of entries) {
    // Keep the public status payload bounded while preserving the comparator's best entries.
    let insertAt = selected.length;
    for (let index = 0; index < selected.length; index += 1) {
      if (compare(entry, expectDefined(selected[index], "selected entry at index")) < 0) {
        insertAt = index;
        break;
      }
    }
    if (insertAt < DREAMING_ENTRY_LIST_LIMIT) {
      selected.splice(insertAt, 0, entry);
      if (selected.length > DREAMING_ENTRY_LIST_LIMIT) {
        selected.pop();
      }
    } else if (selected.length < DREAMING_ENTRY_LIST_LIMIT) {
      selected.push(entry);
    }
  }
  return selected;
}

async function loadDreamingStoreStats(
  workspaceDir: string,
  nowMs: number,
  loadShortTermPromotionDreamingStats: DoctorMemoryStatusCoreRuntime["loadShortTermPromotionDreamingStats"],
  timezone?: string,
): Promise<DreamingStoreStats> {
  try {
    return await loadShortTermPromotionDreamingStats({ workspaceDir, nowMs, timezone });
  } catch (err) {
    return {
      shortTermCount: 0,
      recallSignalCount: 0,
      dailySignalCount: 0,
      groundedSignalCount: 0,
      totalSignalCount: 0,
      phaseSignalCount: 0,
      lightPhaseHitCount: 0,
      remPhaseHitCount: 0,
      promotedTotal: 0,
      promotedToday: 0,
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      storeError: formatError(err),
    };
  }
}

function mergeDreamingStoreStats(stats: DreamingStoreStats[]): DreamingStoreStats {
  let shortTermCount = 0;
  let recallSignalCount = 0;
  let dailySignalCount = 0;
  let groundedSignalCount = 0;
  let totalSignalCount = 0;
  let phaseSignalCount = 0;
  let lightPhaseHitCount = 0;
  let remPhaseHitCount = 0;
  let promotedTotal = 0;
  let promotedToday = 0;
  let latestPromotedAtMs = Number.NEGATIVE_INFINITY;
  let lastPromotedAt: string | undefined;
  const storePaths = new Set<string>();
  const phaseSignalPaths = new Set<string>();
  const storeErrors: string[] = [];
  const phaseSignalErrors: string[] = [];
  const shortTermEntries: ShortTermDreamingStatsEntry[] = [];
  const signalEntries: ShortTermDreamingStatsEntry[] = [];
  const promotedEntries: ShortTermDreamingStatsEntry[] = [];

  for (const stat of stats) {
    shortTermCount += stat.shortTermCount;
    recallSignalCount += stat.recallSignalCount;
    dailySignalCount += stat.dailySignalCount;
    groundedSignalCount += stat.groundedSignalCount;
    totalSignalCount += stat.totalSignalCount;
    phaseSignalCount += stat.phaseSignalCount;
    lightPhaseHitCount += stat.lightPhaseHitCount;
    remPhaseHitCount += stat.remPhaseHitCount;
    promotedTotal += stat.promotedTotal;
    promotedToday += stat.promotedToday;
    if (stat.storePath) {
      storePaths.add(stat.storePath);
    }
    if (stat.phaseSignalPath) {
      phaseSignalPaths.add(stat.phaseSignalPath);
    }
    if (stat.storeError) {
      storeErrors.push(stat.storeError);
    }
    if (stat.phaseSignalError) {
      phaseSignalErrors.push(stat.phaseSignalError);
    }
    shortTermEntries.push(...stat.shortTermEntries);
    signalEntries.push(...stat.signalEntries);
    promotedEntries.push(...stat.promotedEntries);
    const promotedAtMs = stat.lastPromotedAt ? Date.parse(stat.lastPromotedAt) : Number.NaN;
    if (Number.isFinite(promotedAtMs) && promotedAtMs > latestPromotedAtMs) {
      latestPromotedAtMs = promotedAtMs;
      lastPromotedAt = stat.lastPromotedAt;
    }
  }

  return {
    shortTermCount,
    recallSignalCount,
    dailySignalCount,
    groundedSignalCount,
    totalSignalCount,
    phaseSignalCount,
    lightPhaseHitCount,
    remPhaseHitCount,
    promotedTotal,
    promotedToday,
    shortTermEntries: trimDreamingEntries(shortTermEntries, compareDreamingEntryByRecency),
    signalEntries: trimDreamingEntries(signalEntries, compareDreamingEntryBySignals),
    promotedEntries: trimDreamingEntries(promotedEntries, compareDreamingEntryByPromotion),
    ...(storePaths.size === 1 ? { storePath: [...storePaths][0] } : {}),
    ...(phaseSignalPaths.size === 1 ? { phaseSignalPath: [...phaseSignalPaths][0] } : {}),
    ...(lastPromotedAt ? { lastPromotedAt } : {}),
    ...(storeErrors.length === 1
      ? { storeError: storeErrors[0] }
      : storeErrors.length > 1
        ? { storeError: `${storeErrors.length} dreaming stores had read errors.` }
        : {}),
    ...(phaseSignalErrors.length === 1
      ? { phaseSignalError: phaseSignalErrors[0] }
      : phaseSignalErrors.length > 1
        ? { phaseSignalError: `${phaseSignalErrors.length} phase signal stores had read errors.` }
        : {}),
  };
}

type ManagedDreamingCronStatus = {
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

type ManagedCronJobLike = {
  name?: string;
  description?: string;
  enabled?: boolean;
  payload?: { kind?: string; text?: string };
  state?: { nextRunAtMs?: number };
};

function isManagedDreamingJob(
  job: ManagedCronJobLike,
  params: { name: string; tag: string; payloadText: string },
): boolean {
  const description = normalizeOptionalString(job.description);
  if (description?.includes(params.tag)) {
    return true;
  }
  // Older managed jobs may lack the tag, so fall back to the exact system-event signature.
  const name = normalizeOptionalString(job.name);
  const payloadKind = normalizeOptionalString(job.payload?.kind)?.toLowerCase();
  const payloadText = normalizeOptionalString(job.payload?.text);
  return (
    name === params.name && payloadKind === "systemevent" && payloadText === params.payloadText
  );
}

async function resolveManagedDreamingCronStatus(params: {
  context: {
    cron?: { list?: (opts?: { includeDisabled?: boolean }) => Promise<unknown[]> };
  };
  match: {
    name: string;
    tag: string;
    payloadText: string;
  };
}): Promise<ManagedDreamingCronStatus> {
  if (!params.context.cron || typeof params.context.cron.list !== "function") {
    return { managedCronPresent: false };
  }
  try {
    const jobs = await params.context.cron.list({ includeDisabled: true });
    const managed = jobs
      .filter((job): job is ManagedCronJobLike => typeof job === "object" && job !== null)
      .filter((job) => isManagedDreamingJob(job, params.match));
    let nextRunAtMs: number | undefined;
    for (const job of managed) {
      if (job.enabled !== true) {
        continue;
      }
      const candidate = job.state?.nextRunAtMs;
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        continue;
      }
      if (nextRunAtMs === undefined || candidate < nextRunAtMs) {
        nextRunAtMs = candidate;
      }
    }
    return {
      managedCronPresent: managed.length > 0,
      ...(nextRunAtMs !== undefined ? { nextRunAtMs } : {}),
    };
  } catch {
    return { managedCronPresent: false };
  }
}

async function resolveAllManagedDreamingCronStatuses(context: {
  cron?: { list?: (opts?: { includeDisabled?: boolean }) => Promise<unknown[]> };
}): Promise<Record<"light" | "deep" | "rem", ManagedDreamingCronStatus>> {
  const sweepStatus = await resolveManagedDreamingCronStatus({
    context,
    match: {
      name: MANAGED_DEEP_SLEEP_CRON_NAME,
      tag: MANAGED_DEEP_SLEEP_CRON_TAG,
      payloadText: DEEP_SLEEP_SYSTEM_EVENT_TEXT,
    },
  });
  return {
    light: sweepStatus,
    deep: sweepStatus,
    rem: sweepStatus,
  };
}

function shouldProbeMemoryEmbeddings(params: unknown): boolean {
  if (!params || typeof params !== "object") {
    return false;
  }
  // SAFETY: guarded by the `typeof params !== "object"` check above.
  const record = params as Record<string, unknown>;
  return record.probe === true || record.deep === true;
}

function resolveDoctorMemoryAgent(
  context: GatewayRequestContext,
  params: unknown,
  respond: RespondFn,
  omittedAgentId?: string,
): {
  cfg: OpenClawConfig;
  agentId: string;
  requestedAgentId?: string;
} | null {
  const cfg = context.getRuntimeConfig();
  const record = asOptionalRecord(params);
  const rawAgentId = record?.agentId;
  // Validate before resolving workspace or manager state; both paths can create agent storage.
  if (rawAgentId !== undefined && typeof rawAgentId !== "string") {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId must be a string"));
    return null;
  }
  const requestedAgentId =
    typeof rawAgentId === "string" ? normalizeAgentId(rawAgentId) : undefined;
  let agentId = requestedAgentId ?? omittedAgentId;
  if (!agentId) {
    try {
      agentId = resolveDefaultAgentId(cfg, {
        surface: "doctor memory",
        hint: "Pass agentId to select a configured agent.",
      });
    } catch (error) {
      if (!(error instanceof AgentSelectionRequiredError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
      return null;
    }
  }
  if (requestedAgentId && !listAgentIds(cfg).includes(agentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return { cfg, agentId, ...(requestedAgentId ? { requestedAgentId } : {}) };
}

export function resolveDoctorMemoryTarget(
  context: GatewayRequestContext,
  params: unknown,
  respond: RespondFn,
): {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
} | null {
  const resolved = resolveDoctorMemoryAgent(context, params, respond);
  if (!resolved) {
    return null;
  }
  return {
    cfg: resolved.cfg,
    agentId: resolved.agentId,
    workspaceDir: resolveAgentWorkspaceDir(resolved.cfg, resolved.agentId),
  };
}

/** Determine whether the memory slot is configured and the plugin is enabled. */
function getMemoryEligibility(
  cfg: OpenClawConfig,
): { eligible: true } | { eligible: false; reason: string } {
  if (cfg.plugins?.enabled === false) {
    return { eligible: false, reason: "Plugins system is disabled" };
  }

  // Use resolveSlotSelection to properly check slot state
  const slotValue = cfg.plugins?.slots?.memory;
  const selection = resolveSlotSelection("memory", slotValue);
  if (selection.kind === "off") {
    return { eligible: false, reason: "Memory slot is switched off" };
  }

  // Defer to resolveMemoryRuntimePluginIds (memory-runtime.ts) for the plugins-enabled /
  // deny-list / entry-disabled decision itself, so eligibility can't drift from the runtime's
  // own load policy. Only the human-readable reason is derived locally here.
  const pluginId = selection.pluginId;
  if (!resolveMemoryRuntimePluginIds(cfg).includes(pluginId)) {
    const entry = cfg.plugins?.entries?.[pluginId];
    const verb = entry?.enabled === false ? "disabled" : "denied";
    return { eligible: false, reason: 'Memory plugin "' + pluginId + '" is ' + verb };
  }

  // Manifest-first: the slot owner must DECLARE kind:"memory". Read that from the boot
  // descriptor snapshot, which does not materialize plugin runtime - src/plugins/AGENTS.md
  // ("discovery, config validation, and setup should work from metadata before plugin
  // runtime executes") and src/gateway/AGENTS.md ("should not materialize bundled plugin
  // runtime when they only need plugin-owned static descriptors"). This is the same read
  // cli-root-descriptors.ts:76 performs.
  //
  // A MISSING record does not make the slot ineligible. Eligibility describes declared
  // configuration; absent metadata is unknown, not disqualifying. Collapsing "undeclared"
  // into "wrong kind" would be the same class of mistake as reporting an eligibility fact
  // as a health failure, which is the bug this card exists to fix.
  const record = loadPluginManifestRegistryCore({ config: cfg }).plugins.find(
    (plugin) => plugin.id === pluginId,
  );
  if (record && !hasKind(record.kind, "memory")) {
    return {
      eligible: false,
      reason: 'Plugin "' + pluginId + '" does not declare kind:"memory"',
    };
  }

  return { eligible: true };
}

const SKIPPED_MEMORY_EMBEDDING_PROBE = {
  ok: false,
  checked: false,
  error: "memory embedding readiness not checked; run `openclaw memory status --deep` to probe",
} as const;

export function createDoctorMemoryStatusHandler(
  memoryCoreRuntime: DoctorMemoryStatusCoreRuntime,
): GatewayRequestHandler {
  return async ({ respond, context, params }) => {
    const omittedAgentId = tryResolveAmbientOwnerAgentId(context.getRuntimeConfig());
    const resolved = resolveDoctorMemoryAgent(context, params, respond, omittedAgentId);
    if (!resolved) {
      return;
    }
    const { cfg, agentId, requestedAgentId } = resolved;
    const { manager, error, capabilityRegistered, searchRuntimeRegistered, ownerLoadFailed } =
      await getActiveMemorySearchManagerCore({
        cfg,
        agentId,
        purpose: "status",
      });
    if (!manager) {
      const eligibility = getMemoryEligibility(cfg);
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        eligible: eligibility.eligible,
        ...(eligibility.eligible ? {} : { eligibilityReason: eligibility.reason }),
        // A resolved owner whose manager construction failed is a live health
        // failure, not "unconfigured" - see getActiveMemorySearchManagerCore.
        capabilityRegistered: capabilityRegistered ?? false,
        searchRuntimeRegistered: searchRuntimeRegistered ?? false,
        // A crashed owner must keep the health-failure presentation rather than fall
        // through to the neutral slot-owner hero, which would hide the failure.
        ownerLoadFailed: ownerLoadFailed ?? false,
        embedding: {
          ok: false,
          error: error ?? "memory search unavailable",
        },
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      let status = manager.status();
      const shouldProbe = shouldProbeMemoryEmbeddings(params);
      let embedding = shouldProbe
        ? await manager.probeEmbeddingAvailability()
        : (manager.getCachedEmbeddingAvailability?.() ?? SKIPPED_MEMORY_EMBEDDING_PROBE);
      if (shouldProbe) {
        status = manager.status();
      }
      if (!embedding.ok && !embedding.error) {
        embedding = { ok: false, error: "memory embeddings unavailable" };
      }
      const nowMs = Date.now();
      const dreamingConfig = resolveDreamingConfig(cfg);
      const workspaceDir = normalizeOptionalString(
        // SAFETY: normalizeOptionalString tolerates any shape; this only narrows for property access.
        (status as Record<string, unknown>).workspaceDir,
      );
      const configuredWorkspaces = requestedAgentId
        ? workspaceDir
          ? [workspaceDir]
          : []
        : resolveMemoryDreamingWorkspaces(cfg, {
            primaryWorkspaceDir: workspaceDir,
            primaryAgentId: agentId,
          }).map((entry) => entry.workspaceDir);
      const allWorkspaces =
        configuredWorkspaces.length > 0 ? configuredWorkspaces : workspaceDir ? [workspaceDir] : [];
      const storeStats =
        allWorkspaces.length > 0
          ? mergeDreamingStoreStats(
              await Promise.all(
                allWorkspaces.map((entry) =>
                  loadDreamingStoreStats(
                    entry,
                    nowMs,
                    memoryCoreRuntime.loadShortTermPromotionDreamingStats,
                    dreamingConfig.timezone,
                  ),
                ),
              ),
            )
          : {
              shortTermCount: 0,
              recallSignalCount: 0,
              dailySignalCount: 0,
              groundedSignalCount: 0,
              totalSignalCount: 0,
              phaseSignalCount: 0,
              lightPhaseHitCount: 0,
              remPhaseHitCount: 0,
              promotedTotal: 0,
              promotedToday: 0,
            };
      const cronStatuses = await resolveAllManagedDreamingCronStatuses(context);
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        eligible: true,
        capabilityRegistered: true,
        searchRuntimeRegistered: true,
        ownerLoadFailed: false,
        provider: status.provider,
        embedding,
        embeddingRuntime: (() => {
          const runtime = asOptionalRecord(asOptionalRecord(status.custom)?.llamaCppRuntime);
          return runtime?.engine === "llama.cpp"
            ? (runtime as DoctorMemoryEmbeddingRuntimePayload) // SAFETY: engine check narrows the record to this payload shape.
            : undefined;
        })(),
        dreaming: {
          ...dreamingConfig,
          ...storeStats,
          phases: {
            light: {
              ...dreamingConfig.phases.light,
              ...cronStatuses.light,
            },
            deep: {
              ...dreamingConfig.phases.deep,
              ...cronStatuses.deep,
            },
            rem: {
              ...dreamingConfig.phases.rem,
              ...cronStatuses.rem,
            },
          },
        },
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        eligible: true,
        capabilityRegistered: true,
        searchRuntimeRegistered: true,
        ownerLoadFailed: false,
        embedding: {
          ok: false,
          error: `gateway memory probe failed: ${formatError(err)}`,
        },
      };
      respond(true, payload, undefined);
    } finally {
      await manager.close?.().catch(() => {});
    }
  };
}

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
import { formatErrorMessage as formatError } from "../../infra/errors.js";
import {
  MANAGED_MEMORY_DREAMING_CRON_NAME,
  MANAGED_MEMORY_DREAMING_CRON_TAG,
  MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingWorkspaces,
  resolveMemoryRemDreamingConfig,
  type ShortTermDreamingStatsEntry,
} from "../../memory-host-sdk/dreaming.js";
import * as defaultMemoryCoreRuntime from "../../plugin-sdk/memory-core-bundled-runtime.js";
import { getActiveMemorySearchManagerCore } from "../../plugins/memory-runtime.js";
import { resolveActiveMemoryDreamingStatus } from "../../plugins/memory-state.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { sortAndLimitBy } from "../../shared/sort-and-limit.js";
import {
  composeDreamingPayload,
  EMPTY_DREAMING_STORE_STATS,
  type DoctorMemoryDreamingConfigPayload,
  type DoctorMemoryDreamingPayload,
  type DreamingStoreStats,
  type ManagedDreamingCronStatus,
} from "./doctor-dreaming-status.js";
import {
  listWorkspaceDailyFiles,
  readDreamDiary,
  type DoctorMemoryDreamDiaryPayload,
} from "./doctor-memory-files.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";

export type { DoctorMemoryDreamDiaryPayload } from "./doctor-memory-files.js";

type DoctorMemoryCoreRuntime = Pick<
  typeof defaultMemoryCoreRuntime,
  | "dedupeDreamDiaryEntries"
  | "loadShortTermPromotionDreamingStats"
  | "previewGroundedRemMarkdown"
  | "removeBackfillDiaryEntries"
  | "removeGroundedShortTermCandidates"
  | "repairDreamingArtifacts"
  | "writeBackfillDiaryEntries"
>;


export type DoctorMemoryStatusPayload = {
  agentId: string;
  searchRuntimeRegistered?: boolean;
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

export type DoctorMemoryDreamActionPayload = {
  agentId: string;
  action:
    | "backfill"
    | "reset"
    | "resetGroundedShortTerm"
    | "repairDreamingArtifacts"
    | "dedupeDreamDiary";
  path?: string;
  found?: boolean;
  scannedFiles?: number;
  written?: number;
  replaced?: number;
  removedEntries?: number;
  removedShortTermEntries?: number;
  changed?: boolean;
  archiveDir?: string;
  archivedDreamsDiary?: boolean;
  archivedSessionCorpus?: boolean;
  archivedSessionIngestion?: boolean;
  warnings?: string[];
  dedupedEntries?: number;
  keptEntries?: number;
};

function extractIsoDayFromPath(filePath: string): string | null {
  const match = filePath.replaceAll("\\", "/").match(/(\d{4}-\d{2}-\d{2})(?:-[^/]+)?\.md$/i);
  return match?.[1] ?? null;
}

function groundedMarkdownToDiaryLines(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^##\s+/, "").trimEnd())
    .filter(
      (line, index, lines) =>
        line.length > 0 ||
        (index > 0 && expectDefined(lines[index - 1], "lines entry at index 1")?.length > 0),
    );
}

function resolveDreamingConfig(cfg: OpenClawConfig): DoctorMemoryDreamingConfigPayload {
  const resolved = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
    cfg,
  });
  const { light, deep, rem } = resolved.phases;
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
        enabled: resolved.enabled && light.enabled,
        cron: light.cron,
        lookbackDays: light.lookbackDays,
        limit: light.limit,
        managedCronPresent: false,
      },
      deep: {
        enabled: resolved.enabled && deep.enabled,
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
        enabled: resolved.enabled && rem.enabled,
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

async function loadDreamingStoreStats(
  workspaceDir: string,
  nowMs: number,
  loadShortTermPromotionDreamingStats: DoctorMemoryCoreRuntime["loadShortTermPromotionDreamingStats"],
  timezone?: string,
): Promise<DreamingStoreStats> {
  try {
    return await loadShortTermPromotionDreamingStats({ workspaceDir, nowMs, timezone });
  } catch (err) {
    return {
      ...mergeDreamingStoreStats([]),
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
    shortTermEntries: sortAndLimitBy(
      shortTermEntries,
      DREAMING_ENTRY_LIST_LIMIT,
      compareDreamingEntryByRecency,
    ),
    signalEntries: sortAndLimitBy(
      signalEntries,
      DREAMING_ENTRY_LIST_LIMIT,
      compareDreamingEntryBySignals,
    ),
    promotedEntries: sortAndLimitBy(
      promotedEntries,
      DREAMING_ENTRY_LIST_LIMIT,
      compareDreamingEntryByPromotion,
    ),
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

type ManagedCronJobLike = {
  name?: string;
  description?: string;
  enabled?: boolean;
  payload?: { kind?: string; text?: string };
  state?: { nextRunAtMs?: number };
};

function isManagedDreamingJob(job: ManagedCronJobLike): boolean {
  const description = normalizeOptionalString(job.description);
  if (description?.includes(MANAGED_MEMORY_DREAMING_CRON_TAG)) {
    return true;
  }
  // Older managed jobs may lack the tag, so fall back to the exact system-event signature.
  const name = normalizeOptionalString(job.name);
  const payloadKind = normalizeOptionalString(job.payload?.kind)?.toLowerCase();
  const payloadText = normalizeOptionalString(job.payload?.text);
  return (
    name === MANAGED_MEMORY_DREAMING_CRON_NAME &&
    payloadKind === "systemevent" &&
    payloadText === MEMORY_DREAMING_SYSTEM_EVENT_TEXT
  );
}

async function resolveManagedDreamingCronStatus(context: {
  cron?: { list?: (opts?: { includeDisabled?: boolean }) => Promise<unknown[]> };
}): Promise<ManagedDreamingCronStatus> {
  if (!context.cron || typeof context.cron.list !== "function") {
    return { managedCronPresent: false };
  }
  try {
    const jobs = await context.cron.list({ includeDisabled: true });
    const managed = jobs
      .filter((job): job is ManagedCronJobLike => typeof job === "object" && job !== null)
      .filter(isManagedDreamingJob);
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

function shouldProbeMemoryEmbeddings(params: unknown): boolean {
  if (!params || typeof params !== "object") {
    return false;
  }
  const record = params as Record<string, unknown>;
  return record.probe === true || record.deep === true;
}

function resolveDoctorMemoryAgent(
  context: GatewayRequestContext,
  params: unknown,
  respond: RespondFn,
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
  let agentId = requestedAgentId ?? tryResolveAmbientOwnerAgentId(cfg);
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

function resolveDoctorMemoryTarget(
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

function memoryActionHandler(
  action: DoctorMemoryDreamActionPayload["action"],
  run: (
    target: NonNullable<ReturnType<typeof resolveDoctorMemoryTarget>>,
  ) => Promise<Omit<DoctorMemoryDreamActionPayload, "agentId" | "action">>,
): GatewayRequestHandler {
  return async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    respond(true, { agentId: target.agentId, action, ...(await run(target)) }, undefined);
  };
}

const SKIPPED_MEMORY_EMBEDDING_PROBE = {
  ok: false,
  checked: false,
  error: "memory embedding readiness not checked; run `openclaw memory status --deep` to probe",
} as const;

export const createDoctorHandlers = (
  memoryCoreRuntime: DoctorMemoryCoreRuntime = defaultMemoryCoreRuntime,
): GatewayRequestHandlers => ({
  "doctor.memory.status": async ({ respond, context, params }) => {
    const resolved = resolveDoctorMemoryAgent(context, params, respond);
    if (!resolved) {
      return;
    }
    const { cfg, agentId, requestedAgentId } = resolved;
    const { manager, error, searchRuntimeRegistered } = await getActiveMemorySearchManagerCore({
      cfg,
      agentId,
      purpose: "status",
    });
    if (!manager) {
      // A slot owner may report dreaming without registering search. Its
      // report is the only dreaming data on this path; without one the
      // response stays exactly as it was.
      const reportedDreaming = await resolveActiveMemoryDreamingStatus({ cfg, agentId });
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        searchRuntimeRegistered,
        embedding: {
          ok: false,
          error: error ?? "memory search unavailable",
        },
        ...(reportedDreaming
          ? {
              dreaming: composeDreamingPayload(
                { ...resolveDreamingConfig(cfg), ...EMPTY_DREAMING_STORE_STATS },
                await resolveManagedDreamingCronStatus(context),
                reportedDreaming,
              ),
            }
          : {}),
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
      const reportedDreaming = await resolveActiveMemoryDreamingStatus({ cfg, agentId });
      const workspaceDir = normalizeOptionalString(
        (status as Record<string, unknown>).workspaceDir,
      );
      const allWorkspaces = requestedAgentId
        ? workspaceDir
          ? [workspaceDir]
          : []
        : resolveMemoryDreamingWorkspaces(cfg, {
            primaryWorkspaceDir: workspaceDir,
            primaryAgentId: agentId,
          }).map((entry) => entry.workspaceDir);
      const storeStats = mergeDreamingStoreStats(
        allWorkspaces.length === 0
          ? []
          : await Promise.all(
              allWorkspaces.map((entry) =>
                loadDreamingStoreStats(
                  entry,
                  nowMs,
                  memoryCoreRuntime.loadShortTermPromotionDreamingStats,
                  dreamingConfig.timezone,
                ),
              ),
            ),
      );
      const cronStatus = await resolveManagedDreamingCronStatus(context);
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        provider: status.provider,
        embedding,
        embeddingRuntime: (() => {
          const runtime = asOptionalRecord(asOptionalRecord(status.custom)?.llamaCppRuntime);
          return runtime?.engine === "llama.cpp"
            ? (runtime as DoctorMemoryEmbeddingRuntimePayload)
            : undefined;
        })(),
        dreaming: composeDreamingPayload(
          { ...dreamingConfig, ...storeStats },
          cronStatus,
          reportedDreaming,
        ),
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: `gateway memory probe failed: ${formatError(err)}`,
        },
      };
      respond(true, payload, undefined);
    } finally {
      await manager.close?.().catch(() => {});
    }
  },
  "doctor.memory.dreamDiary": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { agentId, workspaceDir } = target;
    const dreamDiary = await readDreamDiary(workspaceDir);
    const payload: DoctorMemoryDreamDiaryPayload = {
      agentId,
      ...dreamDiary,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.backfillDreamDiary": memoryActionHandler(
    "backfill",
    async ({ cfg, workspaceDir }) => {
      const sourceFiles = await listWorkspaceDailyFiles(workspaceDir);
      if (sourceFiles.length === 0) {
        const dreamDiary = await readDreamDiary(workspaceDir);
        return {
          path: dreamDiary.path,
          found: dreamDiary.found,
          scannedFiles: 0,
          written: 0,
          replaced: 0,
        };
      }
      const grounded = await memoryCoreRuntime.previewGroundedRemMarkdown({
        workspaceDir,
        inputPaths: sourceFiles,
      });
      const remConfig = resolveMemoryRemDreamingConfig({
        pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
        cfg,
      });
      const entries = grounded.files
        .map((file) => {
          const isoDay = extractIsoDayFromPath(file.path);
          if (!isoDay) {
            return null;
          }
          return {
            isoDay,
            sourcePath: file.path,
            bodyLines: groundedMarkdownToDiaryLines(file.renderedMarkdown),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      const written = await memoryCoreRuntime.writeBackfillDiaryEntries({
        workspaceDir,
        entries,
        timezone: remConfig.timezone,
      });
      const dreamDiary = await readDreamDiary(workspaceDir);
      return {
        path: dreamDiary.path,
        found: dreamDiary.found,
        scannedFiles: grounded.scannedFiles,
        written: written.written,
        replaced: written.replaced,
      };
    },
  ),
  "doctor.memory.resetDreamDiary": memoryActionHandler("reset", async ({ workspaceDir }) => {
    const removed = await memoryCoreRuntime.removeBackfillDiaryEntries({ workspaceDir });
    const dreamDiary = await readDreamDiary(workspaceDir);
    return {
      path: dreamDiary.path,
      found: dreamDiary.found,
      removedEntries: removed.removed,
    };
  }),
  "doctor.memory.resetGroundedShortTerm": memoryActionHandler(
    "resetGroundedShortTerm",
    async ({ workspaceDir }) => {
      const removed = await memoryCoreRuntime.removeGroundedShortTermCandidates({ workspaceDir });
      return { removedShortTermEntries: removed.removed };
    },
  ),
  "doctor.memory.repairDreamingArtifacts": memoryActionHandler(
    "repairDreamingArtifacts",
    async ({ workspaceDir }) => {
      const repair = await memoryCoreRuntime.repairDreamingArtifacts({ workspaceDir });
      return {
        changed: repair.changed,
        archiveDir: repair.archiveDir,
        archivedDreamsDiary: repair.archivedDreamsDiary,
        archivedSessionCorpus: repair.archivedSessionCorpus,
        archivedSessionIngestion: repair.archivedSessionIngestion,
        warnings: repair.warnings,
      };
    },
  ),
  "doctor.memory.dedupeDreamDiary": memoryActionHandler(
    "dedupeDreamDiary",
    async ({ workspaceDir }) => {
      const dedupe = await memoryCoreRuntime.dedupeDreamDiaryEntries({ workspaceDir });
      const dreamDiary = await readDreamDiary(workspaceDir);
      return {
        path: dreamDiary.path,
        found: dreamDiary.found,
        removedEntries: dedupe.removed,
        dedupedEntries: dedupe.removed,
        keptEntries: dedupe.kept,
      };
    },
  ),
});

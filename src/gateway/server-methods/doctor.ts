import { expectDefined } from "@openclaw/normalization-core";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../../cron/types.js";
import { formatErrorMessage as formatError } from "../../infra/errors.js";
import {
  MANAGED_MEMORY_DREAMING_CRON_NAME,
  MANAGED_MEMORY_DREAMING_CRON_TAG,
  MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingWorkspaces,
  resolveMemoryRemDreamingConfig,
  type ShortTermDreamingStats,
  type ShortTermDreamingStatsEntry,
} from "../../memory-host-sdk/dreaming.js";
import * as defaultMemoryCoreRuntime from "../../plugin-sdk/memory-core-bundled-runtime.js";
import type { MemoryHealth } from "../../plugins/memory-provider-types.js";
import {
  getActiveMemorySearchManagerCore,
  resolveActiveMemoryBackendConfig,
} from "../../plugins/memory-runtime.js";
import { sortAndLimitBy } from "../../shared/sort-and-limit.js";
import {
  listWorkspaceDailyFiles,
  readDreamDiary,
  type DoctorMemoryDreamDiaryPayload,
} from "./doctor-memory-files.js";
import {
  respondProviderMemoryStatus,
  SKIPPED_MEMORY_EMBEDDING_PROBE,
} from "./doctor-memory-provider-status.js";
import {
  memoryActionHandler,
  resolveDoctorMemoryAgent,
  resolveDoctorMemoryTarget,
} from "./doctor-memory-target.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

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

type DreamingStoreStats = Omit<ShortTermDreamingStats, "storePath" | "phaseSignalPath"> & {
  storePath?: string;
  phaseSignalPath?: string;
  storeError?: string;
};

type DoctorMemoryDreamingPayload = ReturnType<typeof resolveDreamingConfig> & DreamingStoreStats;

export type DoctorMemoryStatusPayload = {
  agentId: string;
  searchRuntimeRegistered?: boolean;
  provider?: string;
  health?: MemoryHealth;
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

export type { DoctorMemoryDreamActionPayload } from "./doctor-memory-target.js";

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

function resolveDreamingConfig(cfg: OpenClawConfig) {
  const resolved = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
    cfg,
  });
  const { light, deep, rem } = resolved.phases;
  const cronStatus: ManagedDreamingCronStatus = { managedCronPresent: false };
  return {
    enabled: resolved.enabled,
    ...(resolved.timezone ? { timezone: resolved.timezone } : {}),
    verboseLogging: resolved.verboseLogging,
    storageMode: resolved.storage.mode,
    separateReports: resolved.storage.separateReports,
    phases: {
      light: {
        enabled: resolved.enabled && light.enabled,
        cron: light.cron,
        lookbackDays: light.lookbackDays,
        limit: light.limit,
        ...cronStatus,
      },
      deep: {
        enabled: resolved.enabled && deep.enabled,
        cron: deep.cron,
        limit: deep.limit,
        minScore: deep.minScore,
        minRecallCount: deep.minRecallCount,
        minUniqueQueries: deep.minUniqueQueries,
        recencyHalfLifeDays: deep.recencyHalfLifeDays,
        ...cronStatus,
        ...(typeof deep.maxAgeDays === "number" ? { maxAgeDays: deep.maxAgeDays } : {}),
      },
      rem: {
        enabled: resolved.enabled && rem.enabled,
        cron: rem.cron,
        lookbackDays: rem.lookbackDays,
        limit: rem.limit,
        minPatternStrength: rem.minPatternStrength,
        ...cronStatus,
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
  const totals = {
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
  let latestPromotedAtMs = Number.NEGATIVE_INFINITY;
  let lastPromotedAt: string | undefined;
  const storePaths = new Set(stats.flatMap((stat) => (stat.storePath ? [stat.storePath] : [])));
  const phaseSignalPaths = new Set(
    stats.flatMap((stat) => (stat.phaseSignalPath ? [stat.phaseSignalPath] : [])),
  );
  const storeErrors = stats.flatMap((stat) => (stat.storeError ? [stat.storeError] : []));
  const phaseSignalErrors = stats.flatMap((stat) =>
    stat.phaseSignalError ? [stat.phaseSignalError] : [],
  );

  for (const stat of stats) {
    totals.shortTermCount += stat.shortTermCount;
    totals.recallSignalCount += stat.recallSignalCount;
    totals.dailySignalCount += stat.dailySignalCount;
    totals.groundedSignalCount += stat.groundedSignalCount;
    totals.totalSignalCount += stat.totalSignalCount;
    totals.phaseSignalCount += stat.phaseSignalCount;
    totals.lightPhaseHitCount += stat.lightPhaseHitCount;
    totals.remPhaseHitCount += stat.remPhaseHitCount;
    totals.promotedTotal += stat.promotedTotal;
    totals.promotedToday += stat.promotedToday;
    const promotedAtMs = stat.lastPromotedAt ? Date.parse(stat.lastPromotedAt) : Number.NaN;
    if (Number.isFinite(promotedAtMs) && promotedAtMs > latestPromotedAtMs) {
      latestPromotedAtMs = promotedAtMs;
      lastPromotedAt = stat.lastPromotedAt;
    }
  }

  return {
    ...totals,
    shortTermEntries: sortAndLimitBy(
      stats.flatMap((stat) => stat.shortTermEntries),
      DREAMING_ENTRY_LIST_LIMIT,
      compareDreamingEntryByRecency,
    ),
    signalEntries: sortAndLimitBy(
      stats.flatMap((stat) => stat.signalEntries),
      DREAMING_ENTRY_LIST_LIMIT,
      compareDreamingEntryBySignals,
    ),
    promotedEntries: sortAndLimitBy(
      stats.flatMap((stat) => stat.promotedEntries),
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

type ManagedDreamingCronStatus = {
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

function isManagedDreamingJob(job: CronJob): boolean {
  const description = normalizeOptionalString(job.description);
  if (description?.includes(MANAGED_MEMORY_DREAMING_CRON_TAG)) {
    return true;
  }
  // Older managed jobs may lack the tag, so fall back to the exact system-event signature.
  const name = normalizeOptionalString(job.name);
  return (
    name === MANAGED_MEMORY_DREAMING_CRON_NAME &&
    job.payload.kind === "systemEvent" &&
    normalizeOptionalString(job.payload.text) === MEMORY_DREAMING_SYSTEM_EVENT_TEXT
  );
}

async function resolveManagedDreamingCronStatus(
  context: Pick<GatewayRequestContext, "cron">,
): Promise<ManagedDreamingCronStatus> {
  try {
    const jobs = await context.cron.list({ includeDisabled: true });
    const managed = jobs.filter(isManagedDreamingJob);
    let nextRunAtMs: number | undefined;
    for (const job of managed) {
      if (!job.enabled) {
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

export const createDoctorHandlers = (
  memoryCoreRuntime: DoctorMemoryCoreRuntime = defaultMemoryCoreRuntime,
): GatewayRequestHandlers => ({
  "doctor.memory.status": async ({
    respond,
    context,
    params,
    client,
    signal,
    hasCurrentClientAuthority,
  }) => {
    const resolved = resolveDoctorMemoryAgent(context, params, respond);
    if (!resolved) {
      return;
    }
    const { cfg, agentId, requestedAgentId } = resolved;
    const backend = resolveActiveMemoryBackendConfig({ cfg, agentId });
    if (backend?.backend === "provider-runtime") {
      await respondProviderMemoryStatus({
        cfg,
        agentId,
        providerId: backend.providerId,
        respond,
        context,
        client,
        signal,
        hasCurrentClientAuthority,
      });
      return;
    }
    const { manager, error, searchRuntimeRegistered } = await getActiveMemorySearchManagerCore({
      cfg,
      agentId,
      purpose: "status",
    });
    if (!manager) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        searchRuntimeRegistered,
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
      const shouldProbe = params.probe === true || params.deep === true;
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
      for (const phase of Object.values(dreamingConfig.phases)) {
        Object.assign(phase, cronStatus);
      }
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
        dreaming: {
          ...dreamingConfig,
          ...storeStats,
        },
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: `gateway memory check failed: ${formatError(err)}`,
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

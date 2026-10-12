import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionActorMemoryUsageSnapshot } from "../config/sessions/session-actor-memory-usage-contract.js";
import type { SessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { buildUsageOverview } from "../shared/usage-overview.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import type { UsageCostResolver } from "./session-cost-usage-pricing.js";
import {
  projectCostUsageSummary,
  projectSessionCostSummaries,
} from "./session-cost-usage-projection.js";
import {
  decodeUsageCostRollupEnvelope,
  encodeUsageCostRollup,
  isUsageCostRollupFresh,
} from "./session-cost-usage-rollup-codec.js";
import { scanMemoryUsageCostRollup } from "./session-cost-usage-rollup-scan.js";
import type {
  UsageCostWorkerOperation,
  UsageCostWorkerResult,
} from "./session-cost-usage-worker.types.js";
import type { UsageCostTranscriptFile } from "./session-cost-usage.types.js";

// Computation holds no actor FIFO turn. Overlapping refreshes simply reuse the next refresh request.
const refreshes = new Set<string>();
function refreshKey(binding: SessionActorStorageBinding): string {
  return JSON.stringify([binding.agentId, binding.path]);
}
export function isSessionActorUsageRefreshRunning(binding: SessionActorStorageBinding): boolean {
  return refreshes.has(refreshKey(binding));
}

function transcriptFile(
  binding: SessionActorStorageBinding,
  instance: SessionActorMemoryUsageSnapshot,
): UsageCostTranscriptFile {
  const filePath = formatSqliteSessionFileMarker({
    agentId: binding.agentId,
    storePath: binding.path,
    sessionId: instance.sessionId,
  });
  return {
    kind: "sqlite",
    filePath,
    sourcePath: filePath,
    sessionId: instance.sessionId,
    mtimeMs: instance.stats.lastMutationAtMs ?? 0,
    size: instance.stats.sizeBytes,
    eventCount: instance.stats.eventCount,
    maxSeq: instance.stats.maxSeq,
  };
}

/** Selected memory acquisition bypasses the database worker and its host SQL requests completely. */
export async function runSessionActorUsage(
  binding: SessionActorStorageBinding,
  operation: UsageCostWorkerOperation,
  resolveCost: UsageCostResolver,
): Promise<UsageCostWorkerResult | { kind: "busy" }> {
  const refresh = operation.kind === "refresh";
  const key = refreshKey(binding);
  if (refresh && refreshes.has(key)) {
    return { kind: "busy" };
  }
  if (refresh) {
    refreshes.add(key);
  }
  try {
    const requested =
      operation.kind === "sessions"
        ? operation.sessions.map((entry) => entry.sessionFile)
        : operation.kind === "summary"
          ? undefined
          : operation.sessionFiles;
    const requestedSessionId = (file: string) => {
      const marker = parseSqliteSessionFileMarker(file);
      if (!marker || marker.agentId !== binding.agentId || marker.storePath !== binding.path) {
        throw new Error("Usage request belongs to another session owner");
      }
      return marker.sessionId;
    };
    const ids = requested?.map(requestedSessionId);
    if (operation.kind === "refresh") {
      operation.rebuildRows?.forEach((row) => requestedSessionId(row.key));
    }
    const instances = await binding.actor.storage!.read(
      {
        type: "session.usage.snapshot",
        input: {
          includeEvents: refresh,
          includeRollupBodies: operation.kind === "summary" || operation.kind === "sessions",
          ...(ids ? { sessionIds: ids } : {}),
        },
      },
      binding.authority,
    );
    const files = new Map(
      instances.map((instance) => {
        const file = transcriptFile(binding, instance);
        return [file.filePath, { file, instance }] as const;
      }),
    );
    const selectedFiles = requested?.map((file) => files.get(file)?.file);
    if (operation.kind === "inventory") {
      return {
        kind: "inventory",
        files: (selectedFiles ?? [...files.values()].map(({ file }) => file))
          .filter(
            (file): file is UsageCostTranscriptFile =>
              file !== undefined &&
              (operation.minMtimeMs === undefined || file.mtimeMs >= operation.minMtimeMs),
          )
          .map(({ kind, sourcePath, sessionId, mtimeMs }) => ({
            kind,
            sourcePath,
            sessionId,
            mtimeMs,
          })),
      };
    }
    const rows = new Map<string, SessionCostUsageRollupRow>();
    for (const [filePath, { instance }] of files) {
      if (instance.rollup) {
        rows.set(filePath, {
          key: filePath,
          valueJson: instance.rollup.valueJson,
          updatedAt: instance.rollup.updatedAt,
        });
      }
    }
    if (operation.kind === "summary" || operation.kind === "sessions") {
      const consumed = new Set<string>();
      const invalidRows = new Map<string, SessionCostUsageRollupRow>();
      const source = {
        readRow(filePath: string) {
          consumed.add(filePath);
          return rows.get(filePath);
        },
        readBody(row: SessionCostUsageRollupRow) {
          return files.get(row.key)?.instance.rollup?.blob ?? null;
        },
        onInvalidBody(filePath: string) {
          const row = rows.get(filePath);
          if (row) {
            invalidRows.set(filePath, row);
          }
        },
        remainingRows: (function* () {
          for (const row of rows.values()) {
            if (!consumed.has(row.key)) {
              yield row;
            }
          }
        })(),
      };
      const result =
        operation.kind === "summary"
          ? {
              kind: "summary" as const,
              summary: await projectCostUsageSummary({
                ...source,
                ...operation,
                files: [...files.values()].map(({ file }) => file),
              }),
            }
          : {
              kind: "sessions" as const,
              ...(await projectSessionCostSummaries({
                ...source,
                ...operation,
                files: selectedFiles ?? [],
              })),
            };
      // This is the disclosure boundary; ordinary bookkeeping uses the captured immutable snapshot.
      binding.actor.snapshot(binding.authority);
      if (result.kind === "sessions" && operation.kind === "sessions" && operation.overview) {
        return {
          kind: "overview",
          result: buildUsageOverview({
            ...operation.overview,
            summaries: result.summaries,
            dayBucket: operation.dayBucket,
          }),
          cacheStatus: result.cacheStatus,
          staleSessionFiles: result.staleSessionFiles,
          invalidRows: [...invalidRows.values()],
        };
      }
      return { ...result, invalidRows: [...invalidRows.values()] };
    }
    if (selectedFiles?.some((file) => !file)) {
      throw new Error("A requested usage transcript is unavailable");
    }
    const rebuild = new Set(operation.rebuildRows?.map((row) => row.key));
    const selected = requested && new Set(requested);
    const stale = [...files.values()]
      .filter(({ file }) => {
        if (
          selected?.size
            ? !selected.has(file.filePath)
            : operation.startMs !== undefined && file.mtimeMs < operation.startMs
        ) {
          return false;
        }
        const row = rows.get(file.filePath);
        const envelope =
          row && decodeUsageCostRollupEnvelope(row.valueJson, operation.pricingFingerprint);
        return (
          rebuild.has(file.filePath) ||
          !isUsageCostRollupFresh({ file, checkpoint: envelope?.checkpoint })
        );
      })
      .toSorted(
        (a, b) => a.file.size - b.file.size || a.file.filePath.localeCompare(b.file.filePath),
      );
    const limit =
      operation.maxFiles && Number.isFinite(operation.maxFiles) && operation.maxFiles > 0
        ? Math.floor(operation.maxFiles)
        : undefined;
    let changed = false;
    for (const { file, instance } of stale.slice(0, limit)) {
      getAsyncWorkSignal()?.throwIfAborted();
      const entry = await scanMemoryUsageCostRollup({
        file,
        events: instance.events ?? [],
        pricingFingerprint: operation.pricingFingerprint,
        resolveCosts: async (pairs) => pairs.map(resolveCost),
      });
      const encoded = encodeUsageCostRollup(entry);
      const outcome = await binding.actor.storage!.mutate(
        {
          type: "session.usage.write",
          input: {
            sessionId: instance.sessionId,
            rollup: { ...encoded, updatedAt: entry.scannedAt },
          },
        },
        binding.authority,
      );
      if (outcome.kind === "rolled-back") {
        throw new Error(outcome.error.message);
      }
      changed ||= outcome.value;
    }
    if (!limit || stale.length <= limit) {
      return { kind: "refresh", changed };
    }
    return {
      kind: "refresh",
      changed,
      remainingFiles: stale.slice(limit).map(({ file }) => ({
        sessionFile: file.sourcePath,
        rollupId: file.filePath,
      })),
    };
  } finally {
    if (refresh) {
      refreshes.delete(key);
    }
  }
}

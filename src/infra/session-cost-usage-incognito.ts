import { randomUUID } from "node:crypto";
import {
  formatSqliteSessionFileMarker,
  sqliteSessionFileMarkerMatchesTarget,
  type SqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import type {
  IncognitoComputeOperations,
  IncognitoComputeTarget,
} from "../config/sessions/session-incognito-compute-contract.js";
import type { IncognitoComputeScope } from "../config/sessions/session-incognito-compute.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import type { SessionCostUsageRollupSnapshot } from "./session-cost-usage-cache.kernel.js";
import type { UsageCostWorkerHostRequest } from "./session-cost-usage-worker.types.js";

export type UsageCostIncognitoBinding = {
  actor: IncognitoAgentDatabaseExecution;
  authority: IncognitoSessionAuthority;
  target: IncognitoComputeTarget;
};

/** Explicit inactive routing; physical identity and cleanup belong to the captured actor. */
export function createIncognitoUsageCostAdapter(
  compute: IncognitoComputeScope,
  target: IncognitoComputeTarget,
  marker: SqliteSessionFileMarker,
) {
  const filePath = formatSqliteSessionFileMarker(marker);
  const sources = new Map<string, string>();
  const assertMarker = (input: SqliteSessionFileMarker) => {
    if (!sqliteSessionFileMarkerMatchesTarget(formatSqliteSessionFileMarker(input), marker)) {
      throw new Error("Usage worker requested another incognito session");
    }
  };
  const startedAt = Date.now();
  const lockJson = JSON.stringify({ pid: process.pid, startedAt, ownerNonce: randomUUID() });
  return {
    filePath,
    assertCurrent: compute.assertCurrent,
    lock: {
      async acquire() {
        const previousRaw = await compute.execute({
          type: "session.compute.usage.refreshLock",
          input: { ...target, request: {} },
        });
        return compute.execute({
          type: "session.compute.usage.acquireLock",
          input: {
            ...target,
            request: {
              previousRaw,
              previousOwnerIsRunning: previousRaw !== null,
              lockJson,
              startedAt,
            },
          },
        });
      },
      writeRollup(
        request: IncognitoComputeOperations["session.compute.usage.writeRollup"]["input"]["request"],
      ) {
        return compute.execute({
          type: "session.compute.usage.writeRollup",
          input: { ...target, request },
        });
      },
      pruneRows(request: readonly SessionCostUsageRollupSnapshot[]) {
        return compute.execute({
          type: "session.compute.usage.prune",
          input: { ...target, request },
        });
      },
    },
    async read(request: UsageCostWorkerHostRequest) {
      switch (request.kind) {
        case "memory-stats":
          return Promise.all(
            request.input.map((input) => {
              assertMarker(input);
              return compute.execute({
                type: "session.compute.usage.stats",
                input: { ...target, request: {} },
              });
            }),
          );
        case "memory-cache":
          return compute.execute({
            type: "session.compute.usage.cache",
            input: { ...target, request: { filePaths: request.input.filePaths ?? [filePath] } },
          });
        case "memory-cache-body":
          return compute.execute({
            type: "session.compute.usage.cacheBody",
            input: { ...target, request: request.input },
          });
        case "memory-transcript": {
          assertMarker(request.input.marker);
          const key = JSON.stringify(request.input);
          let sourceId = sources.get(key);
          if (!sourceId) {
            sourceId = randomUUID();
            await compute.execute({
              type: "session.compute.source.open",
              input: { ...target, sourceId, range: request.input },
            });
            sources.set(key, sourceId);
          }
          return compute.execute({
            type: "session.compute.source.read",
            input: { ...target, sourceId },
          });
        }
        default:
          throw new Error("Invalid incognito usage read request");
      }
    },
  };
}

import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { PageCacheProgress } from "../infra/sqlite-page-cache.worker.js";
import {
  runSqliteReadOnlyOperation,
  withSqliteReadOnlyWorkerScope,
} from "../infra/sqlite-readonly-worker.js";
import { readDatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import type { PreparedStartupSessionDatabase } from "./server-startup-session-migration.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";

const BYTES_PER_SECOND = 16 * 1024 * 1024;
const MAX_PASS_BYTES = 2 * 1024 * 1024 * 1024;

/** Each pass owns one cancellable reader; no page map or SQLite snapshot survives it. */
export async function warmGatewayDatabasePageCache(params: {
  databases: readonly PreparedStartupSessionDatabase[];
  signal: AbortSignal;
  startupTrace?: GatewayStartupTrace;
  log: { info: (message: string) => void; warn: (message: string) => void };
}): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }
  const statePath = resolveOpenClawStateSqlitePath();
  const state = captureOpenClawStateReadContext(statePath);
  const targets = [
    {
      path: statePath,
      kind: "state" as const,
      assertCurrent: () => state.admission.assertCurrent(),
      env: process.env,
    },
    ...params.databases.map(({ database, assertCurrent }) => ({
      path: database.path,
      kind: "agent" as const,
      assertCurrent,
      env: database.env ?? process.env,
    })),
  ];
  let remaining = MAX_PASS_BYTES;
  for (const target of targets) {
    if (params.signal.aborted || remaining <= 0) {
      return;
    }
    // Best-effort maintenance never retains a worker beyond its bounded warm window.
    const signal = AbortSignal.any([params.signal, AbortSignal.timeout(3 * 60 * 1000)]);
    try {
      target.assertCurrent();
      const identity = await readDatabasePathIdentity(target.path);
      target.assertCurrent();
      const options = {
        source: "canonical" as const,
        expectedIdentity: identity.key,
        signal,
        env: target.env,
      };
      await withSqliteReadOnlyWorkerScope(
        async () => {
          const started = performance.now();
          let progress = await runSqliteReadOnlyOperation(
            target.path,
            {
              type: "pageCache.begin",
              input: { kind: target.kind, maxBytes: remaining, now: Date.now() },
            },
            options,
          );
          const report = (stage: string, value: PageCacheProgress) => {
            params.startupTrace?.detail("database.page-cache", [
              ["database", target.kind],
              ["stage", stage],
              ["residencyScope", value.residency?.scope ?? "unavailable"],
              ["residentRatio", value.residency?.residentRatio ?? -1],
              ["residentRatioAfter", value.residencyAfter?.residentRatio ?? -1],
              ["readBytes", value.readBytes],
              ["diskBytes", value.diskBytes],
              ["payloadBytes", value.payloadBytes],
              ["payloadMessages", value.payloadMessages],
              ["elapsedMs", value.elapsedMs],
              ["projectionQueryBeforeMs", value.queryBeforeMs ?? -1],
              ["projectionQueryAfterMs", value.queryAfterMs ?? -1],
              ["limited", String(value.limited)],
            ]);
          };
          report("probe", progress);
          let reportedAt = started;
          let previousBytes = 0;
          let chunkStarted = performance.now();
          while (!progress.complete) {
            // Idle/startup time must not accumulate credit for an unpaced burst of disk reads.
            await delay(
              Math.max(
                1,
                ((Math.max(progress.readBytes, progress.diskBytes) - previousBytes) /
                  BYTES_PER_SECOND) *
                  1000 -
                  (performance.now() - chunkStarted),
              ),
              undefined,
              { signal },
            );
            target.assertCurrent();
            previousBytes = Math.max(progress.readBytes, progress.diskBytes);
            chunkStarted = performance.now();
            progress = await runSqliteReadOnlyOperation(
              target.path,
              { type: "pageCache.step", input: null },
              options,
            );
            if (performance.now() - reportedAt >= 5000) {
              report("warming", progress);
              reportedAt = performance.now();
            }
          }
          target.assertCurrent();
          remaining -= Math.max(progress.readBytes, progress.diskBytes);
          report("complete", progress);
          params.log.info(
            `database page-cache residency: database=${target.kind} scope=file-sample resident=${((progress.residency?.residentRatio ?? 0) * 100).toFixed(1)}% readBytes=${progress.readBytes} diskBytes=${progress.diskBytes} payloadBytes=${progress.payloadBytes} payloadMessages=${progress.payloadMessages} elapsedMs=${progress.elapsedMs.toFixed(1)} projectionQueryMs=${progress.queryBeforeMs?.toFixed(2) ?? "n/a"}->${progress.queryAfterMs?.toFixed(2) ?? "n/a"} limited=${progress.limited}`,
          );
        },
        { signal, deadlineOwnedByCaller: true },
      );
    } catch (error) {
      if (!params.signal.aborted) {
        params.log.warn(`database page-cache warm failed (${target.kind}): ${String(error)}`);
      }
      // A failed worker has no trustworthy final I/O count; don't spend the budget again.
      return;
    }
  }
}

import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { beginAmbientWatchPrune } from "./session-state-events.ambient-read.js";

const SESSION_STATE_PRUNE_INTERVAL_MS = 60 * 60_000;
const log = createSubsystemLogger("sessions/state-events");
let lastPruneAt = 0;
let prunePending: Promise<void> | undefined;

function reportPruneFailure(error: unknown): void {
  try {
    log.warn(`failed to prune session state history: ${String(error)}`);
  } catch {
    // Pruning cannot fail a committed action, including when its diagnostic sink fails.
  }
}

/** Join explicit sweeps; periodic producers coalesce within the existing retention window. */
export async function pruneSessionStateEvents(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
    now?: number;
    force?: true;
    context?: OpenClawStateWorkerContext;
    /** Recording retains its original scope and session-current admission through pruning. */
    execute?: () => Promise<void>;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  if (!options.force && (prunePending || now - lastPruneAt <= SESSION_STATE_PRUNE_INTERVAL_MS)) {
    return;
  }
  try {
    const context = options.context ?? captureOpenClawStateWorkerContext(options);
    // Explicit sweeps must enforce their cutoff after an earlier periodic prune settles.
    for (let pending = prunePending; pending; pending = prunePending) {
      await pending;
    }
    const finishPrune = beginAmbientWatchPrune(context.admission.identity.key);
    prunePending = Promise.resolve()
      .then(() =>
        options.execute
          ? options.execute()
          : runOpenClawStateWorkerOperation(
              context,
              (scope) => scope.execute({ type: "sessionState.prune", input: { now } }),
              {
                createAdmission: createSqliteWorkerWriteAdmission(
                  () => context.admission.assertCurrent(),
                  [context.admission.databasePath],
                ),
              },
            ),
      )
      .then(() => {
        lastPruneAt = Math.max(lastPruneAt, now);
      })
      .catch(reportPruneFailure)
      .finally(() => {
        finishPrune();
        prunePending = undefined;
      });
    await prunePending;
  } catch (error) {
    reportPruneFailure(error);
  }
}

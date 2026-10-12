import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";

const log = createSubsystemLogger("sessions/state-events");
// Only live prompt-read admissions are retained, never watch rows or cached grants.
const ambientWatchReads = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionState.ambientWatchReads"),
  () => ({
    readers: new Set<{ source: string; current: boolean }>(),
    pruning: new Map<string, number>(),
  }),
);

function invalidateAmbientWatchReads(source: string) {
  for (const reader of ambientWatchReads.readers) {
    if (reader.source === source) {
      reader.current = false;
    }
  }
}

/** Pruning can remove watches; newly admitted reads must also remain undisclosable until settlement. */
export function beginAmbientWatchPrune(source: string): () => void {
  ambientWatchReads.pruning.set(source, (ambientWatchReads.pruning.get(source) ?? 0) + 1);
  invalidateAmbientWatchReads(source);
  return () => {
    const pending = ambientWatchReads.pruning.get(source) ?? 0;
    if (pending <= 1) {
      ambientWatchReads.pruning.delete(source);
    } else {
      ambientWatchReads.pruning.set(source, pending - 1);
    }
  };
}

/** List durable ambient-group targets owned by one watcher; failures grant nothing. */
export function prepareAmbientGroupWatchTargetsRead(
  watcherSessionKey: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  const context = captureOpenClawStateReadWorkerContext(options);
  const captured = { path: context.admission.databasePath, env: context.environment };
  const scope = {
    source: context.admission.identity.key,
    current: !ambientWatchReads.pruning.has(context.admission.identity.key),
  };
  ambientWatchReads.readers.add(scope);
  return {
    assertCurrent: () => context.admission.assertCurrent(),
    isCurrent: () => scope.current,
    release: () => {
      scope.current = false;
      ambientWatchReads.readers.delete(scope);
    },
    async read(): Promise<string[]> {
      if (!scope.current) {
        return [];
      }
      try {
        const result = await executeExistingOpenClawStateRead(
          captured,
          { type: "sessionState.ambientTargets", input: { watcherSessionKey } },
          { context, current: true },
        );
        context.admission.assertCurrent();
        if (result && !result.ok) {
          throw new Error(result.message);
        }
        return result?.type === "sessionState.ambientTargets" ? result.targets : [];
      } catch (error) {
        log.warn(`failed to list ambient group watch targets: ${String(error)}`);
        return [];
      }
    },
  };
}

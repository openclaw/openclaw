import type { RetainedWorkerTransactionAdmission } from "../infra/sqlite-worker-operation-settlement.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { captureOpenClawStateReadWorkerContext } from "./openclaw-state-worker-context.js";
import {
  captureUserPreferenceRead,
  retainUserPreferenceRead,
} from "./user-preferences-publication.js";

type PinSnapshot = { sessionKeys: readonly string[]; isCurrent: () => boolean };
const snapshots = new Map<string, Promise<PinSnapshot>>();
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened" && event.identity) {
    snapshots.delete(event.identity.key);
  }
});

/** One worker-decoded union per preference publication, shared across agent maintenance passes. */
export async function preparePersonalSessionPins(
  options: { path?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const context = captureOpenClawStateReadWorkerContext(options);
  const key = context.admission.identity.key;
  for (;;) {
    let pending = snapshots.get(key);
    if (!pending) {
      pending = (async (): Promise<PinSnapshot> => {
        const isCurrent = await captureUserPreferenceRead(context.admission);
        const reply = await executeExistingOpenClawStateRead(
          { path: context.admission.databasePath, env: context.environment },
          { type: "userPreferences.sessionPins" },
          { context, current: true },
        );
        return { sessionKeys: reply?.sessionKeys ?? [], isCurrent };
      })();
      snapshots.set(key, pending);
    }
    let snapshot: PinSnapshot;
    try {
      snapshot = await pending;
    } catch (error) {
      if (snapshots.get(key) === pending) {
        snapshots.delete(key);
      }
      throw error;
    }
    if (snapshots.get(key) !== pending) {
      continue;
    }
    if (!snapshot.isCurrent()) {
      snapshots.delete(key);
      continue;
    }
    const operations = new WeakSet<RetainedWorkerTransactionAdmission>();
    return {
      ...snapshot,
      retainOperation(operation: RetainedWorkerTransactionAdmission) {
        if (operations.has(operation)) {
          return;
        }
        // A final commit guard calls this without yielding after snapshot validation.
        // Planning and post-commit archive I/O must not block queued pin writers.
        retainUserPreferenceRead(context.admission, snapshot.isCurrent, operation);
        operations.add(operation);
      },
    };
  }
}

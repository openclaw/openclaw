import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-async-lifecycle.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStateDatabaseLifecycleListener,
} from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import type { OpenClawStateWorkerOperations } from "./openclaw-state-worker-contract.js";

type Store = SqliteWorkerStore<OpenClawStateWorkerOperations>;
const log = createSubsystemLogger("state/worker");

function createSharedStateWorkerOwner() {
  const stores = new Map<string, Promise<Store>>();
  const retiring = new Map<string, Promise<void>>();
  async function close(identity?: DatabasePathIdentity): Promise<void> {
    const entries = [...stores].filter(([key]) => identity === undefined || identity.key === key);
    for (const [key, opening] of entries) {
      stores.delete(key);
      const closing = opening.then((store) => store.close());
      retiring.set(key, closing);
      void closing
        .finally(() => {
          if (retiring.get(key) === closing) {
            retiring.delete(key);
          }
        })
        .catch(() => {});
    }
    // Broker close settles only after native cleanup or joined worker exit.
    const settled = await Promise.allSettled(
      [...retiring]
        .filter(([key]) => identity === undefined || identity.key === key)
        .map(([, closing]) => closing),
    );
    const errors = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close shared-state SQLite workers");
    }
  }
  registerOpenClawStateDatabaseAsyncResource({ close });
  registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind !== "opened" && event.identity) {
      // Synchronous error eviction cannot await, but actor retirement remains
      // owned and every subsequent open or canonical drain joins it.
      void close(event.identity).catch((error: unknown) => {
        log.warn("Shared-state worker retirement failed", { path: event.path, error });
      });
    }
  });
  return {
    close,
    async open(admission: OpenClawStateDatabaseReadAdmission) {
      const closing = retiring.get(admission.identity.key);
      if (closing) {
        await closing;
      }
      admission.assertCurrent();
      let key = admission.identity.key;
      let opening = stores.get(key);
      if (!opening) {
        // Restore can already be ready after a native close. Reuse canonical
        // schema admission once when establishing a new worker actor as well.
        openOpenClawStateDatabase({ path: admission.databasePath });
        admission.assertCurrent();
        // Native publication promotes a prospective identity without replacing
        // its admission. Reuse the physical actor if another alias already opened it.
        key = admission.identity.key;
        const promotedClosing = retiring.get(key);
        if (promotedClosing) {
          await promotedClosing;
          admission.assertCurrent();
        }
        opening = stores.get(key);
        if (opening) {
          return opening;
        }
        opening = openSqliteWorkerStore<OpenClawStateWorkerOperations>({
          moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sharedStateStore),
          databasePath: admission.databasePath,
          input: undefined,
          existingOnly: true,
        }).then((store) => {
          if (!store) {
            throw new Error("Admitted shared-state database is missing");
          }
          return store;
        });
        stores.set(key, opening);
        const admitted = opening;
        void opening.catch(() => {
          if (stores.get(key) === admitted) {
            stores.delete(key);
          }
        });
      }
      return opening;
    },
  };
}

function owner() {
  return resolveGlobalSingleton(
    Symbol.for("openclaw.sharedStateWorkerOwner"),
    createSharedStateWorkerOwner,
    (sharedOwner) => sharedOwner.close(),
  );
}

export async function executeOpenClawStateWorker<Key extends keyof OpenClawStateWorkerOperations>(
  context: OpenClawStateDatabaseReadAdmission,
  command: { type: Key; input: OpenClawStateWorkerOperations[Key]["input"] },
): Promise<OpenClawStateWorkerOperations[Key]["output"]> {
  const store = await owner().open(context);
  context.assertCurrent();
  const result = await store.execute(command);
  context.assertCurrent();
  return result;
}

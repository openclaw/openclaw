import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import { readDatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { runSqliteWorkerStoreOperation } from "../../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { openOpenClawStateWorkerCleanupStore } from "../../state/openclaw-state-worker-store.js";

/** Installation owns its exact lease until the callback and accepted worker work settle. */
export async function withSkillUploadInstallOwner<T>(
  context: OpenClawStateWorkerContext,
  lease: { uploadId: string; owner: string },
  operation: (claimStarted: () => void) => Promise<T>,
): Promise<T> {
  const producer = createDeferredCore();
  let identity: string | undefined;
  let active = true;
  let released = false;
  let cleanup: Promise<void> | undefined;
  let store: Awaited<ReturnType<typeof openOpenClawStateWorkerCleanupStore>>;
  const cleanupContext = {
    environment: context.environment,
    existingSchemaPath: context.existingSchemaPath,
  };
  const assertOwned = () => {
    if (!active || !identity) {
      throw new Error("Skill upload install cleanup owner has settled");
    }
  };
  const close = (): Promise<void> =>
    !active
      ? Promise.resolve()
      : (cleanup ??= (async () => {
          await producer.promise;
          // Retry a failed transport close before inspecting a possibly replaced path.
          if (store) {
            await store.close();
            store = undefined;
          }
          if (identity && !released) {
            assertOwned();
            const observed = await readDatabasePathIdentity(context.admission.databasePath);
            if (observed.key !== identity) {
              throw new Error("Skill upload cleanup cannot adopt a replacement shared database");
            }
            store ??= await openOpenClawStateWorkerCleanupStore(
              context.admission.databasePath,
              cleanupContext,
              assertOwned,
            );
            if (!store) {
              throw new Error("Skill upload cleanup lost its original shared database");
            }
            const errors: unknown[] = [];
            try {
              if (!released) {
                const input = {
                  ...lease,
                  sharedStateIdentity: identity,
                };
                await runSqliteWorkerStoreOperation(
                  store,
                  (scope) => scope.execute({ type: "skillUploads.release", input }),
                  cleanupContext,
                  assertOwned,
                );
                released = true;
              }
            } catch (error) {
              errors.push(error);
            }
            try {
              await store.close();
              store = undefined;
            } catch (error) {
              errors.push(error);
            }
            throwSqliteLifecycleErrors(
              errors,
              "Skill upload lease release and worker cleanup failed",
            );
          }
          active = false;
          unregister();
        })().finally(() => {
          cleanup = undefined;
        }));
  const unregister = registerOpenClawStateDatabaseAsyncResource({
    async close(target) {
      if (!target || target.key === context.admission.identity.key) {
        await close();
      }
    },
  });
  context.maintenanceScope?.own(producer, "shared-resources", close);
  try {
    return await operation(() => {
      context.admission.assertCurrent();
      identity = context.admission.identity.key;
    });
  } finally {
    producer.resolve();
    await close();
  }
}

import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { requestClientCredentialsFromApp } from "./client-credential-ipc.js";
import {
  resolveClientCredentialStorePath,
  clientCredentialOperationCreatesStore,
  isClientCredentialMutation,
  isClientCredentialBusyError,
  missingClientCredentialResult,
  type ClientCredentialOperation,
  type ClientCredentialResult,
} from "./client-credential-store.js";
import type { ClientCredentialWorkerOperations } from "./client-credential.worker.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import type { SqliteWorkerStore } from "./sqlite-worker-contract.js";
import { resolveDatabasePathKey } from "./sqlite-worker-identity.js";
import { openSqliteWorkerStore, runSqliteWorkerStoreWrite } from "./sqlite-worker-store.js";

const queues = resolveGlobalSingleton(
  Symbol.for("openclaw.clientCredentialOperations"),
  () => new Map<string, Promise<void>>(),
);

/** Run one bounded off-thread operation, routing to the app when it owns this root. */
export async function runClientCredentialOperationAsync(
  env: NodeJS.ProcessEnv,
  operation: ClientCredentialOperation,
  options: { signal?: AbortSignal; assertCurrent?: () => void } = {},
): Promise<ClientCredentialResult> {
  const root = resolveDatabasePathKey(path.resolve(resolveStateDir(env)));
  const capturedEnv = {
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    OPENCLAW_PROFILE: env.OPENCLAW_PROFILE,
    OPENCLAW_STATE_DIR: root,
  };
  const databasePath = resolveClientCredentialStorePath({ OPENCLAW_STATE_DIR: root });
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
  };
  assertCurrent();
  const previous = queues.get(root) ?? Promise.resolve();
  const operationPromise = previous.then(async () => {
    const offline = async (timeoutMs: number) => {
      assertCurrent();
      let store: SqliteWorkerStore<ClientCredentialWorkerOperations> | undefined;
      try {
        const createIfMissing = clientCredentialOperationCreatesStore(operation);
        store = await openSqliteWorkerStore<ClientCredentialWorkerOperations>({
          moduleUrl: resolveRuntimeProcessEntrypointUrl("clientCredentials"),
          databasePath,
          existingOnly: !createIfMissing,
          input: {
            root,
            createIfMissing,
            readOnly: !isClientCredentialMutation(operation),
            timeoutMs,
          },
        });
        assertCurrent();
        if (!store) {
          return {
            kind: "result" as const,
            result: missingClientCredentialResult(capturedEnv, operation),
          };
        }
        const result = await runSqliteWorkerStoreWrite(
          store,
          (scope) =>
            scope.execute({ type: "execute", input: operation }, { signal: options.signal }),
          assertCurrent,
          [databasePath],
        );
        assertCurrent();
        return { kind: "result" as const, result };
      } catch (error) {
        if (isClientCredentialBusyError(error)) {
          return { kind: "busy" as const };
        }
        throw error;
      } finally {
        await store?.close();
      }
    };
    const maintenance = getOpenClawDatabaseMaintenanceScope();
    if (maintenance?.ownsSchemaMaintenance) {
      maintenance.assertAdmission();
    } else {
      assertCurrent();
      const result = await requestClientCredentialsFromApp(
        capturedEnv,
        operation,
        options.signal,
        assertCurrent,
      );
      assertCurrent();
      if (result) {
        return result;
      }
    }
    // An uncertain app dispatch is terminal. Offline custody requires no app
    // request, an explicit unowned-root refusal, or held maintenance admission.
    const retried = await offline(5_000);
    if (retried.kind === "result") {
      return retried.result;
    }
    throw new Error("Client credentials are busy; retry after the current owner finishes.");
  });
  const settled = operationPromise.then(
    () => {},
    () => {},
  );
  queues.set(root, settled);
  try {
    return await operationPromise;
  } finally {
    if (queues.get(root) === settled) {
      queues.delete(root);
    }
  }
}

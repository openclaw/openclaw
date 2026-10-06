import { randomUUID } from "node:crypto";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type {
  SecretStoreBatchWriteParams as KernelBatchParams,
  SecretStoreWriteParams as KernelWriteParams,
  SecretStoreWriteSnapshot,
} from "./secret-store-write.js";

export type { SecretStoreWriteEntry } from "./secret-store-write.js";
type WorkerWriteOptions = {
  database?: Pick<NonNullable<KernelWriteParams["database"]>, "path" | "env">;
  assertCurrent?: () => void;
};
export type SecretStoreWriteParams = Omit<KernelWriteParams, "database"> & WorkerWriteOptions;
export type SecretStoreBatchWriteParams = Omit<KernelBatchParams, "database"> & WorkerWriteOptions;

function admission(context: OpenClawStateWorkerContext, assertCallerCurrent?: () => void) {
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertCallerCurrent?.();
  };
  return {
    assertCurrent,
    createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
      context.admission.databasePath,
    ]),
  };
}

function write(params: SecretStoreBatchWriteParams, capturePrevious: boolean) {
  const context = captureOpenClawStateWorkerContext(params.database);
  const { database: _database, assertCurrent, ...input } = params;
  const captured = structuredClone(input);
  const now = Date.now();
  for (const entry of captured.entries) {
    registerSecretValueForRedaction(entry.value);
    if (entry.expectedValue !== undefined) {
      registerSecretValueForRedaction(entry.expectedValue);
    }
  }
  const result = runOpenClawStateWorkerOperation(
    context,
    async (scope) => {
      const results = await scope.execute({
        type: "secrets.write",
        input: { ...captured, capturePrevious, now },
      });
      for (const written of results) {
        if (written.previous) {
          registerSecretValueForRedaction(written.previous.value);
        }
      }
      return results;
    },
    admission(context, assertCurrent),
  );
  return { context, result };
}

export async function writeSecretStoreEntries(params: SecretStoreBatchWriteParams) {
  return (await write(params, false).result).map((result) => result.kind);
}

export async function writeSecretStoreEntry(params: SecretStoreWriteParams) {
  const { scope, database, updatedBy, inheritExistingKind, assertCurrent, ...entry } = params;
  const [kind] = await writeSecretStoreEntries({
    scope,
    database,
    updatedBy,
    inheritExistingKind,
    assertCurrent,
    entries: [entry],
  });
  if (!kind) {
    throw new Error("Secret store write returned no entry result.");
  }
  return kind;
}

export async function deleteSecretStoreEntry(
  params: Pick<SecretStoreWriteParams, "scope" | "name" | "database" | "assertCurrent">,
): Promise<void> {
  const context = captureOpenClawStateWorkerContext(params.database);
  const input = { scope: { ...params.scope }, name: params.name, now: Date.now() };
  await runOpenClawStateWorkerOperation(
    context,
    (owner) =>
      owner.execute({
        type: "secrets.delete",
        input,
      }),
    admission(context, params.assertCurrent),
  );
}

/** Compensation stays bound to the original physical store and exact writer. */
export async function writeSecretStoreEntryWithRollback(params: SecretStoreWriteParams) {
  const { scope, database, updatedBy, inheritExistingKind, assertCurrent, ...entry } = params;
  const capturedScope = { ...scope };
  const writer = `${updatedBy ?? "secret-store"}:${randomUUID()}`;
  const pending = write(
    {
      scope: capturedScope,
      database,
      updatedBy: writer,
      inheritExistingKind,
      assertCurrent,
      entries: [entry],
    },
    true,
  );
  const [result] = await pending.result;
  if (!result) {
    throw new Error("Secret store write returned no entry result.");
  }
  const previous: SecretStoreWriteSnapshot | undefined = result.previous;
  let rollback: Promise<boolean> | undefined;
  return {
    rollback: () => {
      const now = Date.now();
      return (rollback ??= runOpenClawStateWorkerOperation(
        pending.context,
        (owner) =>
          owner.execute({
            type: "secrets.rollback",
            input: {
              scope: capturedScope,
              name: entry.name,
              expectedUpdatedBy: writer,
              previous,
              now,
            },
          }),
        // Exact-write compensation retains cleanup authority after the requester ends.
        admission(pending.context),
      ));
    },
  };
}

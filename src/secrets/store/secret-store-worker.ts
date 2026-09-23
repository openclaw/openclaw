import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { SecretStoreReadResult } from "./secret-store-worker-contract.js";
import type { SecretStoreWriteParams } from "./secret-store.js";

export async function readSecretStoreValueAsync(params: {
  scope: { kind: "team" };
  name: string;
  database?: OpenClawStateDatabaseOptions;
}): Promise<SecretStoreReadResult> {
  try {
    const reply = await executeExistingOpenClawStateRead(params.database ?? {}, {
      type: "secrets.store.read",
      name: params.name,
    });
    if (reply === undefined) {
      return {
        ok: false,
        error: { code: "SECRET_STORE_NOT_FOUND", message: "Secret store entry was not found." },
      };
    }
    if (!reply.ok || reply.type !== "secrets.store.read") {
      throw new Error("Unexpected secret store read result");
    }
    if (reply.value.ok) {
      registerSecretValueForRedaction(reply.value.value);
    }
    return reply.value;
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "SECRET_STORE_UNAVAILABLE",
        message: "Secret store database is unavailable.",
        cause,
      },
    };
  }
}

/** Keep physical actor custody through config publication and any exact compensation. */
export async function withSecretStoreStagedWrite<T>(
  params: SecretStoreWriteParams,
  assertCurrent: () => void,
  operation: (stage: { rollback: () => Promise<boolean> }) => Promise<T>,
): Promise<T> {
  registerSecretValueForRedaction(params.value);
  const { database, ...input } = params;
  const context = captureOpenClawStateWorkerContext(database);
  let compensating = false;
  const assertOwned = () => {
    context.admission.assertCurrent();
    // Revoked caller authority cannot prevent compensation of its own exact write.
    if (!compensating) {
      assertCurrent();
    }
  };
  return runOpenClawStateWorkerOperation(
    context,
    async (scope) => {
      const receipt = await scope.execute({ type: "secrets.store.stage", input });
      if (receipt.previous) {
        registerSecretValueForRedaction(receipt.previous.value);
      }
      let rollback: Promise<boolean> | undefined;
      return operation({
        rollback: () => {
          compensating = true;
          return (rollback ??= scope.execute({ type: "secrets.store.rollback", input: receipt }));
        },
      });
    },
    {
      assertCurrent: assertOwned,
      createAdmission: createSqliteWorkerWriteAdmission(assertOwned, [
        context.admission.databasePath,
      ]),
    },
  );
}

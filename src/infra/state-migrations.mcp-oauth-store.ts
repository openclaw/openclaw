import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { SqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "./sqlite-worker-operation-settlement.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import type {
  LegacyMcpOAuthImportResult,
  PreparedLegacyMcpOAuthImport,
} from "./state-migrations.mcp-oauth.worker-contract.js";

type ImportOutcome =
  | { ok: true; value: LegacyMcpOAuthImportResult; deliveryFailure?: { error: unknown } }
  | { ok: false; error: unknown; restoreSource: boolean };

/** Keep the filesystem claim until the original native writer's outcome is known. */
export async function importLegacyMcpOAuthStore(
  context: OpenClawStateWorkerContext,
  input: PreparedLegacyMcpOAuthImport,
): Promise<ImportOutcome> {
  let retained:
    | { operation: RetainedWorkerTransactionAdmission; admission: SqliteWorkerOperationAdmission }
    | undefined;
  let commitRequested = false;
  const createAdmission = createSqliteWorkerWriteAdmission(
    (request) => {
      context.admission.assertCurrent();
      if (request.stage === "commit") {
        // A failed grant may be definite, but it never justifies restoring an uncertain claim.
        commitRequested = true;
      }
    },
    [context.admission.databasePath],
  );
  try {
    const value = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "legacyMcpOAuth.import", input }),
      {
        createAdmission(operation) {
          const created = createAdmission(operation);
          retained = { operation, admission: created.admission };
          return created;
        },
      },
    );
    return { ok: true, value };
  } catch (error) {
    if (!retained) {
      return { ok: false, error, restoreSource: true };
    }
    const settlement = await retained.operation.settled;
    const facts = retained.admission.committed?.facts;
    if (
      settlement.kind === "completed" &&
      isRecord(facts) &&
      facts.sourceKey === input.sourceKey &&
      typeof facts.imported === "boolean"
    ) {
      return {
        ok: true,
        value: { sourceKey: input.sourceKey, imported: facts.imported },
        deliveryFailure: { error },
      };
    }
    return {
      ok: false,
      error,
      restoreSource:
        settlement.kind === "not-entered" || (settlement.kind === "completed" && !commitRequested),
    };
  }
}

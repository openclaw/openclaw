import type { DatabaseSync } from "node:sqlite";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
} from "../infra/sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import {
  publishAgentSchemaMetadata,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-metadata.js";
import { agentDatabaseValidationKey } from "./openclaw-agent-db-validation-facts.js";

/** Known derived-schema owners preserve agent contracts they do not change. */
export function stageOpenClawAgentDatabaseSchemaExtension(db: DatabaseSync): void {
  const validation = getSqliteDatabaseAdmission(db, agentDatabaseValidationKey);
  if (!validation?.schema || Atomics.load(new Int32Array(validation.schema.valid), 0) !== 1) {
    return;
  }
  const metadata = readExistingAgentSchemaMeta(db);
  if (
    !stageSqliteTransactionState(db, {
      stage: () => {},
      rollback: () => {},
      commit: () => {
        // Native settlement captures the extension's complete catalog, including virtual shadows.
        const facts = getAdmittedSqliteSchemaFacts(db);
        if (!facts) {
          return;
        }
        const valid = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
        Atomics.store(new Int32Array(valid), 0, 1);
        publishSqliteDatabaseAdmission(db, agentDatabaseValidationKey, {
          ...validation,
          schema: { facts, valid },
        });
        if (metadata) {
          publishAgentSchemaMetadata(db, metadata);
        }
      },
    })
  ) {
    throw new Error("Agent schema extensions require a managed transaction");
  }
}

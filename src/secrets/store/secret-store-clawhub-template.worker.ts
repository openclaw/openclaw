import { createHash } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { ensureSecretStoreSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
import { withMissingSecretStoreFallback } from "./secret-store-sqlite.js";
import { assertSecretStoreValueLength } from "./secret-store-value.js";

export type TemplateClawHubCredentialTarget = { profileId: string; baseUrl: string };

// The host cannot name another identity secret, even through a worker command.
function registryName(baseUrl: string) {
  return "clawhub-template:" + createHash("sha256").update(baseUrl).digest("hex");
}

export const templateClawHubReadOperations = {
  "templateClawHub.read": ({ profileId, baseUrl }: TemplateClawHubCredentialTarget, db) => {
    const row = withMissingSecretStoreFallback(
      () =>
        executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
            .selectFrom("secret_store_entries")
            .select(["kind", "value", "allowed_hosts"])
            .where("scope_kind", "=", "identity")
            .where("scope_id", "=", profileId)
            .where("name", "=", registryName(baseUrl))
            .where("deleted_at_ms", "is", null),
        ),
      undefined,
    );
    if (row) {
      if (row.kind !== "secret" || row.allowed_hosts !== null) {
        throw new Error("Invalid personal ClawHub credential. Sign in to ClawHub again.");
      }
      assertSecretStoreValueLength(row.value, "secret");
    }
    return { type: "templateClawHub.read" as const, value: row?.value };
  },
} satisfies WorkerOperationHandlers<EngineConnection>;

export const templateClawHubWriteOperations = {
  "templateClawHub.write": (
    { profileId, baseUrl, value }: TemplateClawHubCredentialTarget & { value: string },
    { writeAdmitted },
  ) => {
    assertSecretStoreValueLength(value, "secret");
    return writeAdmitted(
      ({ db }) => {
        ensureSecretStoreSchema(db);
        const now = Date.now();
        const credential = {
          value,
          kind: "secret",
          allowed_hosts: null,
          updated_by: null,
          deleted_at_ms: null,
          updated_at_ms: now,
        };
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
            .insertInto("secret_store_entries")
            .values({
              scope_kind: "identity",
              scope_id: profileId,
              name: registryName(baseUrl),
              ...credential,
              created_at_ms: now,
            })
            .onConflict((conflict) =>
              conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet(credential),
            ),
        );
      },
      { operationLabel: "secrets.store.write-template-clawhub" },
    );
  },
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

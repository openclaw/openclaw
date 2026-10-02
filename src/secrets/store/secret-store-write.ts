// Team secret store write transactions: batch upserts, kind inheritance,
// CAS repair writes, and owner-checked rollback.
import { randomUUID } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { ensureSecretStoreSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { isMissingSecretStoreTableError } from "./secret-store-sqlite.js";
import { SecretStoreValidationError } from "./secret-store-validation-error.js";
import {
  assertSecretStoreMutationName,
  assertSecretStoreWriteShape,
  normalizeScope,
  normalizeSecretAllowedHosts,
  type SecretStoreKind,
  type SecretStoreScope,
} from "./secret-store-validation.js";

type SecretStoreDatabase = Pick<OpenClawStateKyselyDatabase, "secret_store_entries">;

export type SecretStoreWriteParams = SecretStoreWriteEntry & {
  scope: SecretStoreScope;
  inheritExistingKind?: boolean;
  updatedBy: string | null;
  database?: OpenClawStateDatabaseOptions;
};

type SecretStoreWriteSnapshot = {
  value: string;
  kind: SecretStoreKind;
  allowedHosts: string | null;
  updatedBy: string | null;
};

export type SecretStoreWriteEntry = {
  name: string;
  value: string;
  kind: SecretStoreKind;
  /** Literal command-line values may only be committed as env entries. */
  valueSource?: "argv";
  /** Replace only the matching value during repair, preserving the current kind and host policy. */
  expectedValue?: string;
  allowedHosts?: readonly string[];
};

export type SecretStoreBatchWriteParams = {
  scope: SecretStoreScope;
  entries: readonly SecretStoreWriteEntry[];
  inheritExistingKind?: boolean;
  updatedBy: string | null;
  database?: OpenClawStateDatabaseOptions;
};

type SecretStoreWriteResult = {
  kind: SecretStoreKind;
  previous: SecretStoreWriteSnapshot | undefined;
};

function writeSecretStoreEntriesInternal(
  params: SecretStoreBatchWriteParams,
  capturePrevious: boolean,
): SecretStoreWriteResult[] {
  const inheritExistingKind = params.inheritExistingKind === true;
  for (const entry of params.entries) {
    assertSecretStoreMutationName(entry.name);
    if (!inheritExistingKind && entry.expectedValue === undefined) {
      assertSecretStoreWriteShape(entry.value, entry.kind, entry.name, entry.allowedHosts);
    }
  }
  const { scopeKind, scopeId } = normalizeScope(params.scope);
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      ensureSecretStoreSchema(sqlite);
      const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
      const resolved = params.entries.map((entry) => {
        const repair = entry.expectedValue !== undefined;
        const previous =
          capturePrevious || inheritExistingKind || repair
            ? executeSqliteQueryTakeFirstSync(
                sqlite,
                db
                  .selectFrom("secret_store_entries")
                  .select(["value", "kind", "allowed_hosts", "updated_by"])
                  .where("scope_kind", "=", scopeKind)
                  .where("scope_id", "=", scopeId)
                  .where("name", "=", entry.name)
                  .where("deleted_at_ms", "is", null),
              )
            : undefined;
        if (repair && previous?.value !== entry.expectedValue) {
          throw new SecretStoreValidationError(
            "SECRET_STORE_VALUE_CHANGED",
            `Secret store entry "${entry.name}" changed before repair; its current value was preserved. Run openclaw doctor again.`,
          );
        }
        // A repair preserves the authoritative row's kind and host policy; a kind-inheriting
        // write resolves the kind from that row before validating the value's shape. A stored
        // value outside the schema domain falls back to the requested kind rather than trusting it.
        const storedKind =
          previous?.kind === "secret" || previous?.kind === "env" ? previous.kind : undefined;
        const kind = repair
          ? (storedKind ?? entry.kind)
          : inheritExistingKind && storedKind !== undefined
            ? storedKind
            : entry.kind;
        if (entry.valueSource === "argv" && kind === "secret") {
          throw new SecretStoreValidationError(
            "SECRET_STORE_VALUE_IN_ARGV",
            "--value is refused for secret entries. Use a stdin pipe, --value-file, or the interactive no-echo prompt.",
          );
        }
        if (inheritExistingKind || repair) {
          assertSecretStoreWriteShape(entry.value, kind, entry.name, entry.allowedHosts);
        }
        const allowedHosts =
          kind === "secret" && entry.allowedHosts !== undefined
            ? normalizeSecretAllowedHosts(entry.allowedHosts)
            : undefined;
        return { entry, previous, kind, allowedHosts, repair };
      });
      for (const { entry, kind, allowedHosts, repair } of resolved) {
        const allowedHostsJson = allowedHosts?.length ? JSON.stringify(allowedHosts) : null;
        executeSqliteQuerySync(
          sqlite,
          db
            .insertInto("secret_store_entries")
            .values({
              scope_kind: scopeKind,
              scope_id: scopeId,
              name: entry.name,
              value: entry.value,
              kind,
              created_at_ms: now,
              updated_at_ms: now,
              updated_by: params.updatedBy,
              deleted_at_ms: null,
              allowed_hosts: allowedHostsJson,
            })
            .onConflict((conflict) =>
              conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet({
                value: entry.value,
                ...(repair ? {} : { kind }),
                updated_at_ms: now,
                updated_by: params.updatedBy,
                deleted_at_ms: null,
                ...(repair
                  ? {}
                  : kind === "env"
                    ? { allowed_hosts: null }
                    : allowedHosts !== undefined
                      ? { allowed_hosts: allowedHostsJson }
                      : {}),
              }),
            ),
        );
      }
      return resolved.map(({ previous, kind }) => ({
        kind,
        previous:
          capturePrevious && previous
            ? {
                value: previous.value,
                // SAFETY: The canonical secret_store schema and write validation restrict kind to secret|env.
                kind: previous.kind as SecretStoreKind,
                allowedHosts: previous.allowed_hosts,
                updatedBy: previous.updated_by,
              }
            : undefined,
      }));
    },
    params.database,
    { operationLabel: "secrets.store.write" },
  );
}

function writeSecretStoreEntryInternal(
  params: SecretStoreWriteParams,
  capturePrevious: boolean,
): SecretStoreWriteResult {
  const [result] = writeSecretStoreEntriesInternal(
    {
      scope: params.scope,
      entries: [
        {
          name: params.name,
          value: params.value,
          kind: params.kind,
          valueSource: params.valueSource,
          allowedHosts: params.allowedHosts,
          ...(params.expectedValue !== undefined ? { expectedValue: params.expectedValue } : {}),
        },
      ],
      inheritExistingKind: params.inheritExistingKind,
      updatedBy: params.updatedBy,
      database: params.database,
    },
    capturePrevious,
  );
  if (!result) {
    throw new Error("Secret store write returned no entry result.");
  }
  return result;
}

export function writeSecretStoreEntry(params: SecretStoreWriteParams): SecretStoreKind {
  return writeSecretStoreEntryInternal(params, false).kind;
}

export function writeSecretStoreEntries(params: SecretStoreBatchWriteParams): SecretStoreKind[] {
  return writeSecretStoreEntriesInternal(params, false).map((result) => result.kind);
}

function rollbackSecretStoreEntryWrite(params: {
  scope: SecretStoreScope;
  name: string;
  expectedUpdatedBy: string;
  previous: SecretStoreWriteSnapshot | undefined;
  database?: OpenClawStateDatabaseOptions;
}): boolean {
  assertSecretStoreMutationName(params.name);
  const { scopeKind, scopeId } = normalizeScope(params.scope);
  const now = Date.now();
  try {
    return runOpenClawStateWriteTransaction(
      ({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        const query =
          params.previous === undefined
            ? db
                .updateTable("secret_store_entries")
                .set({ deleted_at_ms: now, updated_at_ms: now })
                .where("scope_kind", "=", scopeKind)
                .where("scope_id", "=", scopeId)
                .where("name", "=", params.name)
                .where("updated_by", "=", params.expectedUpdatedBy)
                .where("deleted_at_ms", "is", null)
            : db
                .updateTable("secret_store_entries")
                .set({
                  value: params.previous.value,
                  kind: params.previous.kind,
                  allowed_hosts: params.previous.allowedHosts,
                  updated_at_ms: now,
                  updated_by: params.previous.updatedBy,
                  deleted_at_ms: null,
                })
                .where("scope_kind", "=", scopeKind)
                .where("scope_id", "=", scopeId)
                .where("name", "=", params.name)
                .where("updated_by", "=", params.expectedUpdatedBy)
                .where("deleted_at_ms", "is", null);
        const result = executeSqliteQuerySync(sqlite, query);
        return Number(result.numAffectedRows ?? 0n) === 1;
      },
      params.database,
      { operationLabel: "secrets.store.rollback-write" },
    );
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return false;
    }
    throw error;
  }
}

/** Writes one entry and returns owner-checked compensation for that exact write. */
export function writeSecretStoreEntryWithRollback(params: SecretStoreWriteParams): {
  rollback: () => boolean;
} {
  const writer = `${params.updatedBy ?? "secret-store"}:${randomUUID()}`;
  const { previous } = writeSecretStoreEntryInternal({ ...params, updatedBy: writer }, true);
  let rollbackResult: boolean | undefined;
  return {
    rollback: () => {
      if (rollbackResult !== undefined) {
        return rollbackResult;
      }
      rollbackResult = rollbackSecretStoreEntryWrite({
        scope: params.scope,
        name: params.name,
        expectedUpdatedBy: writer,
        previous,
        ...(params.database !== undefined ? { database: params.database } : {}),
      });
      return rollbackResult;
    },
  };
}

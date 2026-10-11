// Team secret store write transactions: batch upserts, kind inheritance,
// CAS repair writes, and owner-checked rollback.
import { expressionBuilder } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { classifyHiddenGitHubStoreName } from "./secret-store-hidden-github.js";
import { withMissingSecretStoreFallback } from "./secret-store-sqlite.js";
import { SecretStoreValidationError } from "./secret-store-validation-error.js";
import {
  assertSecretStoreMutationName,
  assertSecretStoreEnvName,
  assertSecretStoreWriteShape,
  normalizeSecretAllowedHosts,
  type SecretStoreKind,
  type SecretStoreScope,
} from "./secret-store-validation.js";

type SecretStoreDatabase = Pick<OpenClawStateKyselyDatabase, "secret_store_entries">;

export type SecretStoreWriteParams = SecretStoreWriteEntry &
  Omit<SecretStoreBatchWriteParams, "entries">;

export type SecretStoreWriteSnapshot = {
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

export type SecretStoreWriteResult = {
  kind: SecretStoreKind;
  previous: SecretStoreWriteSnapshot | undefined;
};

export function writeSecretStoreEntriesInDatabase(
  params: SecretStoreBatchWriteParams & { now: number },
  capturePrevious: boolean,
  admit: (stage: "transaction" | "commit") => void,
): SecretStoreWriteResult[] {
  const inheritExistingKind = params.inheritExistingKind === true;
  for (const entry of params.entries) {
    assertSecretStoreMutationName(entry.name);
    if (!inheritExistingKind && entry.expectedValue === undefined) {
      assertSecretStoreWriteShape(entry.value, entry.kind, entry.name, entry.allowedHosts);
    }
  }
  const { now } = params;
  return runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      admit("transaction");
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
                  .where("scope_kind", "=", "team")
                  .where("scope_id", "=", "")
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
        const kind = repair || inheritExistingKind ? (storedKind ?? entry.kind) : entry.kind;
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
        const values = {
          value: entry.value,
          updated_at_ms: now,
          updated_by: params.updatedBy,
          deleted_at_ms: null,
        };
        executeSqliteQuerySync(
          sqlite,
          db
            .insertInto("secret_store_entries")
            .values({
              scope_kind: "team",
              scope_id: "",
              name: entry.name,
              ...values,
              kind,
              created_at_ms: now,
              allowed_hosts: allowedHostsJson,
            })
            .onConflict((conflict) =>
              conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet({
                ...values,
                ...(repair ? {} : { kind }),
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
      admit("commit");
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

export function rollbackSecretStoreEntryWriteInDatabase(
  params: {
    scope: SecretStoreScope;
    name: string;
    expectedUpdatedBy: string;
    previous: SecretStoreWriteSnapshot | undefined;
    now: number;
    database?: OpenClawStateDatabaseOptions;
  },
  admit: (stage: "transaction" | "commit") => void,
): boolean {
  assertSecretStoreMutationName(params.name);
  const { now } = params;
  return withMissingSecretStoreFallback(() => {
    return runOpenClawStateWriteTransaction(
      ({ db: sqlite }) => {
        admit("transaction");
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        const query = db
          .updateTable("secret_store_entries")
          .set(
            params.previous === undefined
              ? { deleted_at_ms: now, updated_at_ms: now }
              : {
                  value: params.previous.value,
                  kind: params.previous.kind,
                  allowed_hosts: params.previous.allowedHosts,
                  updated_at_ms: now,
                  updated_by: params.previous.updatedBy,
                  deleted_at_ms: null,
                },
          )
          .where("scope_kind", "=", "team")
          .where("scope_id", "=", "")
          .where("name", "=", params.name)
          .where("updated_by", "=", params.expectedUpdatedBy)
          .where("deleted_at_ms", "is", null);
        const result = executeSqliteQuerySync(sqlite, query);
        admit("commit");
        return Number(result.numAffectedRows ?? 0n) === 1;
      },
      params.database,
      { operationLabel: "secrets.store.rollback-write" },
    );
  }, false);
}

export function deleteSecretStoreEntryInDatabase(
  params: {
    scope: SecretStoreScope;
    name: string;
    now: number;
    database?: OpenClawStateDatabaseOptions;
  },
  admit: (stage: "transaction" | "commit") => void,
): void {
  assertSecretStoreMutationName(params.name);
  const state = openOpenClawStateDatabase(params.database);
  const { now } = params;
  return withMissingSecretStoreFallback(() => {
    runOpenClawStateWriteTransaction(
      ({ db: sqlite }) => {
        admit("transaction");
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        const entry = expressionBuilder<SecretStoreDatabase, "secret_store_entries">().and({
          scope_kind: "team",
          scope_id: "",
          name: params.name,
        });
        const query =
          classifyHiddenGitHubStoreName(params.name) === "setup"
            ? db.deleteFrom("secret_store_entries").where(entry)
            : db
                .updateTable("secret_store_entries")
                .set({ deleted_at_ms: now, updated_at_ms: now })
                .where("deleted_at_ms", "is", null)
                .where(entry);
        executeSqliteQuerySync(sqlite, query);
        admit("commit");
      },
      { ...params.database, database: state },
      { operationLabel: "secrets.store.delete" },
    );
  }, undefined);
}

export function updateSecretStoreAllowedHostsInDatabase(
  params: {
    scope: SecretStoreScope;
    name: string;
    allowedHosts: readonly string[];
    updatedBy: string | null;
    database?: OpenClawStateDatabaseOptions;
    now: number;
  },
  admit: (stage: "transaction" | "commit") => void,
): void {
  assertSecretStoreEnvName(params.name);
  const allowedHosts = normalizeSecretAllowedHosts(params.allowedHosts);
  const { now } = params;
  runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      admit("transaction");
      const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
      const updated = executeSqliteQuerySync(
        sqlite,
        db
          .updateTable("secret_store_entries")
          .set({
            allowed_hosts: allowedHosts.length ? JSON.stringify(allowedHosts) : null,
            updated_at_ms: now,
            updated_by: params.updatedBy,
          })
          .where("scope_kind", "=", "team")
          .where("scope_id", "=", "")
          .where("name", "=", params.name)
          .where("kind", "=", "secret")
          .where("deleted_at_ms", "is", null),
      );
      if (Number(updated.numAffectedRows ?? 0n) !== 1) {
        throw new SecretStoreValidationError(
          "SECRET_STORE_INVALID_ALLOWED_HOST",
          `Secret store entry "${params.name}" is missing or is not a secret entry.`,
        );
      }
      admit("commit");
    },
    params.database,
    { operationLabel: "secrets.store.allowed-hosts" },
  );
}

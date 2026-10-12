import type { DatabaseSync } from "node:sqlite";
import {
  getSqliteDatabaseAdmission,
  hasPendingSqliteDatabaseSchemaMutation,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { schemaAdmission } from "../infra/sqlite-schema-admission.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  isSqliteSchemaAdmissionCold,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";

export type StateSchemaVersionFacts = { userVersion: number; contentVersion: number };

const versionKey: SqliteDatabaseAdmissionKey<StateSchemaVersionFacts> = {
  name: "state.schema-version",
  schemaDependent: true,
  read(value) {
    if (
      typeof value === "object" &&
      value !== null &&
      "userVersion" in value &&
      typeof value.userVersion === "number" &&
      "contentVersion" in value &&
      typeof value.contentVersion === "number"
    ) {
      return { userVersion: value.userVersion, contentVersion: value.contentVersion };
    }
    return undefined;
  },
};

type StateSchemaAdmission<Value> = {
  value: Value;
  admissionId: string;
};

/** Row-backed metadata is valid only for its admitted schema, even if replacement DDL has the same shape. */
export function createStateSchemaAdmission<Value>(
  name: string,
  read: SqliteDatabaseAdmissionKey<Value>["read"],
) {
  const key: SqliteDatabaseAdmissionKey<StateSchemaAdmission<Value>> = {
    name,
    schemaDependent: true,
    read(input) {
      if (
        typeof input !== "object" ||
        input === null ||
        !("value" in input) ||
        !("admissionId" in input) ||
        typeof input.admissionId !== "string"
      ) {
        return undefined;
      }
      const value = read(input.value);
      return value === undefined ? undefined : { value, admissionId: input.admissionId };
    },
  };
  return {
    get(database: DatabaseSync): Value | undefined {
      if (hasPendingSqliteDatabaseSchemaMutation(database)) {
        return undefined;
      }
      const admitted = getSqliteDatabaseAdmission(database, key);
      if (!admitted) {
        return undefined;
      }
      const schema = getAdmittedSqliteSchemaFacts(database);
      return admitted.admissionId === schema?.admissionId ? admitted.value : undefined;
    },
    publish(database: DatabaseSync, value: Value): void {
      if (isSqliteSchemaAdmissionCold(database)) {
        admitSqliteSchema(database);
      }
      const schema = getAdmittedSqliteSchemaFacts(database);
      if (
        !schema ||
        getSqliteDatabaseAdmission(database, schemaAdmission)?.admissionId !== schema.admissionId
      ) {
        return;
      }
      getStateSchemaVersionAdmission(database);
      const admitted = {
        value,
        admissionId: schema.admissionId,
      };
      publishSqliteDatabaseAdmission(database, key, admitted);
    },
  };
}

const runtimeAdmission = createStateSchemaAdmission("state.runtime-schema", (value) =>
  typeof value === "object" &&
  value !== null &&
  "startupReady" in value &&
  typeof value.startupReady === "boolean"
    ? { startupReady: value.startupReady }
    : undefined,
);

type ConnectionVersion = { schema: SqliteSchemaFacts; facts: StateSchemaVersionFacts };
const connectionVersions = new WeakMap<DatabaseSync, ConnectionVersion>();

function rememberConnectionVersion(database: DatabaseSync, value?: ConnectionVersion): void {
  const previous = connectionVersions.get(database);
  const install = (entry: ConnectionVersion | undefined) => {
    if (entry) {
      connectionVersions.set(database, entry);
    } else {
      connectionVersions.delete(database);
    }
  };
  if (
    !stageSqliteTransactionState(database, {
      stage: () => install(value),
      commit: () => {},
      rollback: () => install(previous),
    })
  ) {
    install(value);
  }
}

function schemaVersionKey(
  admissionId: string,
): SqliteDatabaseAdmissionKey<StateSchemaVersionFacts> {
  return { name: `state.schema-version:${admissionId}`, read: versionKey.read };
}

export function getStateSchemaVersionAdmission(database: DatabaseSync) {
  const schema = getAdmittedSqliteSchemaFacts(database);
  if (!schema) {
    return undefined;
  }
  const retained = connectionVersions.get(database);
  if (retained?.schema === schema) {
    return retained.facts;
  }
  const history = getSqliteDatabaseAdmission(database, schemaVersionKey(schema.admissionId));
  const currentSchema = history ? undefined : getSqliteDatabaseAdmission(database, schemaAdmission);
  if (!history && currentSchema?.admissionId !== schema.admissionId) {
    // An unknown or historical snapshot cannot borrow the current catalog's marker.
    return undefined;
  }
  const facts = history ?? getSqliteDatabaseAdmission(database, versionKey);
  if (facts) {
    rememberConnectionVersion(database, { schema, facts });
    if (!history) {
      publishSqliteDatabaseAdmission(database, schemaVersionKey(schema.admissionId), facts);
    }
  }
  return facts;
}

/** A cold snapshot may discover historical facts without replacing a newer publication. */
export function rememberStateSchemaVersionAdmission(
  database: DatabaseSync,
  facts: StateSchemaVersionFacts,
): void {
  const schema = getAdmittedSqliteSchemaFacts(database);
  if (!schema) {
    return;
  }
  rememberConnectionVersion(database, { schema, facts });
  const current = getSqliteDatabaseAdmission(database, schemaAdmission);
  if (current?.admissionId !== schema.admissionId) {
    return;
  }
  publishSqliteDatabaseAdmission(database, schemaVersionKey(schema.admissionId), facts);
  publishSqliteDatabaseAdmission(database, versionKey, facts);
}

export function publishStateSchemaVersionAdmission(
  database: DatabaseSync,
  facts: StateSchemaVersionFacts,
): void {
  publishSqliteDatabaseAdmission(database, versionKey, facts);
  const schema = getAdmittedSqliteSchemaFacts(database);
  if (schema) {
    rememberConnectionVersion(database, { schema, facts });
    publishSqliteDatabaseAdmission(database, schemaVersionKey(schema.admissionId), facts);
  } else {
    rememberConnectionVersion(database);
  }
}

/** Runtime shape and integrity are physical-file facts, independent of live write authority. */
export function getStateRuntimeSchemaAdmission(database: DatabaseSync) {
  return runtimeAdmission.get(database);
}

export function publishStateRuntimeSchemaAdmission(
  database: DatabaseSync,
  startupReady: boolean,
): void {
  runtimeAdmission.publish(database, { startupReady });
}

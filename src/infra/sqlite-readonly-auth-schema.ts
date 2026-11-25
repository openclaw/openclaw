import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  getSqliteDatabaseAdmissionIdentityForPath,
} from "./sqlite-database-admission.js";
import { schemaAdmission } from "./sqlite-schema-admission.js";

type AuthTableKind = "table" | "other" | "missing";
export type SqliteAuthSchema = {
  userVersion: number;
  store: AuthTableKind;
  state: AuthTableKind;
};

/** Project live owner facts; never retain a closed database's schema in the child. */
export function captureSqliteAuthSchema(
  pathname: string,
  expectedIdentity: string,
): SqliteAuthSchema | undefined {
  if (getSqliteDatabaseAdmissionIdentityForPath(pathname)?.key !== expectedIdentity) {
    return undefined;
  }
  const schema = getOrLoadSqliteDatabaseAdmissionForPath(
    pathname,
    schemaAdmission,
    () => undefined,
  );
  if (!schema) {
    return undefined;
  }
  const kind = (name: string): AuthTableKind =>
    schema.tables.has(name)
      ? "table"
      : schema.views.has(name) || schema.indexes.has(name) || schema.triggers.has(name)
        ? "other"
        : "missing";
  return {
    userVersion: schema.userVersion,
    store: kind("auth_profile_store"),
    state: kind("auth_profile_state"),
  };
}

export function readSqliteAuthSchema(value: unknown): SqliteAuthSchema | undefined {
  if (value === undefined) {
    return undefined;
  }
  const isKind = (kind: unknown): kind is AuthTableKind =>
    kind === "table" || kind === "other" || kind === "missing";
  if (
    !isRecord(value) ||
    typeof value.userVersion !== "number" ||
    !Number.isSafeInteger(value.userVersion) ||
    value.userVersion < 0 ||
    !isKind(value.store) ||
    !isKind(value.state)
  ) {
    throw new Error("Invalid auth profile schema projection");
  }
  return { userVersion: value.userVersion, store: value.store, state: value.state };
}

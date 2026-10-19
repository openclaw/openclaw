import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";

// Exchange only the committed receipt, not the potentially large catalog payload.
const catalogReceipt: SqliteDatabaseAdmissionKey<object> = {
  name: "model-catalog.remote",
  read: (value) => (isRecord(value) ? value : undefined),
};

export function readRemoteModelCatalogReceipt(databasePath: string): object {
  return getOrLoadSqliteDatabaseAdmissionForPath(databasePath, catalogReceipt, () => ({})) ?? {};
}

export function publishRemoteModelCatalogChanged(database: EngineConnection): void {
  publishSqliteDatabaseAdmission(database, catalogReceipt, {});
}

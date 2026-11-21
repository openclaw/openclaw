import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { readGeneratedSqliteCatalog } from "../state/postgres-schema.generated/sqlite-catalogs.js";
import {
  sourceRows,
  validateSource,
  hashClientCredentialRows,
} from "./client-credential-migration-data.js";
import { readClientCredentialFileIdentity } from "./client-credential-receipt.js";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "./client-credential-schema.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { assertSqliteSchemaContains } from "./sqlite-schema-contract.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";

/** Read-only classification for the native credential bootstrap that predates engine selection. */
export function isNativeClientCredentialBootstrap(database: DatabaseSync): boolean {
  admitSqliteSchema(database);
  const facts = getAdmittedSqliteSchemaFacts(database)!;
  if (facts.userVersion !== 0) {
    return false;
  }
  const objects = [
    ...[...facts.tables].map((name) => ({ type: "table", name })),
    ...[...facts.indexes].map((name) => ({ type: "index", name })),
    ...[...facts.views].map((name) => ({ type: "view", name })),
    ...[...facts.triggers.keys()].map((name) => ({ type: "trigger", name })),
  ].filter(({ name }) => !name.startsWith("sqlite_"));
  const allowed = new Set([
    "table:device_identities",
    "index:idx_device_identities_device",
    "table:device_auth_tokens",
    "index:idx_device_auth_tokens_updated",
    "table:macos_port_guardian_records",
    "index:idx_macos_port_guardian_records_port",
  ]);
  if (!objects.length || objects.some((object) => !allowed.has(`${object.type}:${object.name}`))) {
    return false;
  }
  if (
    facts.tables.has("macos_port_guardian_records") ||
    facts.indexes.has("idx_macos_port_guardian_records_port")
  ) {
    // Load the canonical companion contract only when validating a present companion.
    const portGuardianTables = readGeneratedSqliteCatalog(OPENCLAW_STATE_SCHEMA_SQL)?.tables.filter(
      ({ name }) => name === "macos_port_guardian_records",
    );
    if (!portGuardianTables?.length) {
      throw new Error("Native PortGuardian companion has no canonical schema catalog.");
    }
    assertSqliteSchemaContains(database, "Native PortGuardian companion", {
      tables: portGuardianTables,
      views: [],
    });
  }
  assertSqliteSchemaContains(
    database,
    "Native client credential bootstrap",
    CLIENT_CREDENTIAL_SCHEMA_SQL,
    {
      allowedMissingTables: [
        "device_identities",
        "device_auth_tokens",
        "gateway_origin_device_tokens",
        "native_exec_socket_credentials",
        "client_credential_migration",
      ],
    },
  );
  return true;
}

/** Independent native sources are read-only; journal bytes and timestamps are not content identity. */
export function readIndependentClientCredentialSource(pathname: string) {
  const file = readClientCredentialFileIdentity(pathname);
  if (!file) {
    throw new Error(
      "Independent client credential source is missing; restore its matching backup.",
    );
  }
  const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(100);
    if (
      fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
      header.subarray(0, 16).toString("binary") !== "SQLite format 3\0" ||
      header[18] !== 1 ||
      header[19] !== 1
    ) {
      throw new Error(
        "Independent client credentials require DELETE journal mode; stop the old client and restore a compatible source.",
      );
    }
  } finally {
    fs.closeSync(fd);
  }
  using database = openNodeSqliteDatabase(pathname, { readOnly: true });
  if (!isNativeClientCredentialBootstrap(database)) {
    throw new Error(
      "Independent client credential source is not a native credential-only database.",
    );
  }
  database.exec("BEGIN"); // sqlite-allow-raw -- Read-only snapshot, without source journaling or mutation.
  try {
    const authTablePresent =
      getAdmittedSqliteSchemaFacts(database)!.tables.has("device_auth_tokens");
    const rows = sourceRows(database, true);
    validateSource(rows);
    const sha256 = hashClientCredentialRows(rows, { authTablePresent });
    return { file, identity: `${file.dev}:${file.ino}`, sha256, rows, authTablePresent };
  } finally {
    database.exec("ROLLBACK"); // sqlite-allow-raw -- Release the read-only snapshot.
  }
}

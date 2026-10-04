import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { FIRST_USE_STATE_TABLES } from "./openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { createSqliteSchemaShapeFromSql } from "./sqlite-schema-shape.test-support.js";

export function createInitialStateSchemaShape(
  deletionJournal: "present" | "unavailable" = "present",
) {
  const shape = createSqliteSchemaShapeFromSql(
    new URL("./openclaw-state-schema.sql", import.meta.url),
  );
  for (const tableName of FIRST_USE_STATE_TABLES) {
    delete shape[tableName];
  }
  if (deletionJournal === "unavailable") {
    delete shape.agent_deletion_journal;
  }
  return shape;
}

const V2026_7_1_2_STATE_FIXTURE_URL = new URL(
  "../../test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz",
  import.meta.url,
);
export const V2026_7_1_2_STATE_FIXTURE_GZIP_SHA256 =
  "c775499d9a46462ae2368090a0c4ec75877784c40694046dd3af63df77b8737c";
export const V2026_7_1_2_STATE_FIXTURE_RAW_SHA256 =
  "8511bb91f02d104f818c70b08397a678045d04741c931b0ee7ce6650b5519e85";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function materializeV2026_7_1_2StateDatabase(stateDir: string): {
  compressedSha256: string;
  databasePath: string;
  rawSha256: string;
} {
  const compressed = fs.readFileSync(V2026_7_1_2_STATE_FIXTURE_URL);
  const raw = gunzipSync(compressed);
  const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.writeFileSync(databasePath, raw);
  return {
    compressedSha256: sha256(compressed),
    databasePath,
    rawSha256: sha256(raw),
  };
}

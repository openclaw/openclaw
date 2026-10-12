import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { preflightOpenClawAgentDatabasePath as preflight } from "./openclaw-agent-schema-inspection.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const root = fs.realpathSync(tempDirs.make("explicit-agent-reader-"));
  const file = path.join(root, "agent.sqlite");
  const db = new (requireNodeSqlite().DatabaseSync)(file);
  db.exec(
    `BEGIN; ${OPENCLAW_AGENT_SCHEMA_SQL}; PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION};`,
  );
  db.prepare(
    "INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,created_at,updated_at) VALUES('primary','agent',?,'main',1,1)",
  ).run(OPENCLAW_AGENT_SCHEMA_VERSION);
  db.exec("COMMIT");
  db.close();
  return { root, file };
}
function family(root: string) {
  return fs
    .readdirSync(root)
    .toSorted()
    .map((name) => {
      const file = path.join(root, name);
      const { dev, ino, mtimeMs, ctimeMs, size } = fs.lstatSync(file);
      return {
        name,
        dev,
        ino,
        mtimeMs,
        ctimeMs,
        size,
        bytes: fs.lstatSync(file).isFile() ? fs.readFileSync(file) : null,
      };
    });
}
describe("explicit agent preflight", () => {
  for (const kind of [
    "directory",
    "wal",
    "wrong-owner",
    "empty-owner",
    "shared-role",
    "missing-label-index",
  ] as const) {
    it(`does not mutate or create a database for ${kind}`, async () => {
      const f = fixture();
      let input = f.file;
      if (kind === "directory") {
        input = f.root;
      }
      if (kind === "wal") {
        fs.writeFileSync(f.file + "-" + kind, "owned sidecar");
      }
      if (kind === "shared-role") {
        const db = new (requireNodeSqlite().DatabaseSync)(f.file);
        db.exec("UPDATE schema_meta SET role='global', agent_id=NULL");
        db.close();
      }
      if (kind === "missing-label-index") {
        const db = new (requireNodeSqlite().DatabaseSync)(f.file);
        db.exec("DROP INDEX IF EXISTS idx_agent_session_nodes_label;");
        db.close();
      }
      const before = family(f.root);
      const result = await preflight(
        input,
        kind === "wrong-owner" ? "other" : kind === "empty-owner" ? "" : "main",
      );
      expect(result.status).toBe(
        kind === "missing-label-index"
          ? "exact"
          : kind === "wrong-owner" || kind === "shared-role"
            ? "incompatible"
            : "indeterminate",
      );
      expect(result.requiresWrite).toBe(false);
      expect(result.databasePath).toBe(input);
      expect(family(f.root)).toEqual(before);
    });
  }
});

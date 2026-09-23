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
    "missing",
    "directory",
    "symlink",
    "wal",
    "shm",
    "journal",
    "wrong-owner",
    "empty-owner",
    "shared-role",
    "missing-label-index",
    "drifted-label-index",
    "wrong-table-label-index",
    "exact",
  ] as const) {
    // File symlink creation on Windows depends on host privilege, not reader behavior.
    it.skipIf(process.platform === "win32" && kind === "symlink")(
      `does not mutate or create a database for ${kind}`,
      async () => {
        const f = fixture();
        let input = f.file;
        if (kind === "missing") {
          input = path.join(f.root, "missing.sqlite");
        }
        if (kind === "directory") {
          input = f.root;
        }
        if (kind === "symlink") {
          input = path.join(f.root, "alias.sqlite");
          fs.symlinkSync(f.file, input);
        }
        if (["wal", "shm", "journal"].includes(kind)) {
          fs.writeFileSync(f.file + "-" + kind, "owned sidecar");
        }
        if (kind === "shared-role") {
          const db = new (requireNodeSqlite().DatabaseSync)(f.file);
          db.exec("UPDATE schema_meta SET role='global', agent_id=NULL");
          db.close();
        }
        if (
          ["missing-label-index", "drifted-label-index", "wrong-table-label-index"].includes(kind)
        ) {
          const db = new (requireNodeSqlite().DatabaseSync)(f.file);
          db.exec("DROP INDEX IF EXISTS idx_agent_session_nodes_label;");
          if (kind === "drifted-label-index") {
            db.exec(
              "CREATE INDEX idx_agent_session_nodes_label ON session_nodes(label, session_key) WHERE archived_at IS NULL;",
            );
          }
          if (kind === "wrong-table-label-index") {
            db.exec("CREATE INDEX idx_agent_session_nodes_label ON session_windows(session_key);");
          }
          db.close();
        }
        const before = family(f.root);
        const result = await preflight(
          input,
          kind === "wrong-owner" ? "other" : kind === "empty-owner" ? "" : "main",
        );
        expect(result.status).toBe(
          kind === "exact" || kind === "missing-label-index"
            ? "exact"
            : [
                  "wrong-owner",
                  "shared-role",
                  "drifted-label-index",
                  "wrong-table-label-index",
                ].includes(kind)
              ? "incompatible"
              : "indeterminate",
        );
        expect(result.requiresWrite).toBe(false);
        expect(result.databasePath).toBe(input);
        expect(family(f.root)).toEqual(before);
      },
    );
  }
});

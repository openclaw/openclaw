import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { dumpGitBackupDatabase } from "./git-backup-codec.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-backup-cache-test-"));
  roots.push(root);
  return root;
}

function createAgentFixture(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    database
      .prepare(
        `INSERT INTO schema_meta
           (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
         VALUES ('primary', 'agent', ?, 'main', NULL, 1, 1)`,
      )
      .run(OPENCLAW_AGENT_SCHEMA_VERSION);
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await fs.rm(root, { recursive: true })));
});

describe("Git-backed SQLite cache secrets", () => {
  it("omits per-agent cache entries from secret-redacted backups", async () => {
    const root = await tempRoot();
    const source = path.join(root, "agent.sqlite");
    const dump = path.join(root, "dump");
    createAgentFixture(source);
    const database = new DatabaseSync(source);
    try {
      database.exec(`
        CREATE TABLE cache_entries (
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT,
          blob BLOB,
          expires_at INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, key)
        ) STRICT;
      `);
      database
        .prepare(
          "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("plugin-model-catalog-v1", "provider", '{"apiKey":"cached-agent-secret"}', 1);
    } finally {
      database.close();
    }

    const manifest = await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: dump,
      identity: { role: "agent", agentId: "main" },
      excludeSecrets: true,
    });

    expect(manifest.excludedTables).toContain("cache_entries");
    expect(manifest.tables).not.toHaveProperty("cache_entries");
    await expect(fs.lstat(path.join(dump, "tables", "cache_entries.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(dump, "schema.sql"), "utf8")).not.toContain("cache_entries");
  });
});

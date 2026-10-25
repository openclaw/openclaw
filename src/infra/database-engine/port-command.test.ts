import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, expect, it } from "vitest";
import "./database-suite-workers.test-support.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { seedPortSqlite } from "./port-command.integration.test-support.js";
import { runDatabasePortTask } from "./port-command.worker.js";
import { loadDatabasePortDescriptor } from "./port-provider-descriptor.js";
import { inspectDatabasePort, type PortDescriptor } from "./port.worker.js";
import { loadStatePortDescriptor } from "./state-port-descriptor.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scope = { assertCurrent() {} };
const inspect = (sourcePath: string) =>
  runDatabasePortTask({ operation: "inspect", sourcePath, config: {}, to: "postgres" }, scope);
let descriptor: PortDescriptor;
beforeAll(async () => {
  descriptor = await loadDatabasePortDescriptor("workboard");
});
function fixture(sql = "") {
  const directory = tempDirs.make("port-command-");
  const sourcePath = path.join(directory, "workboard.sqlite");
  seedPortSqlite(
    sourcePath,
    `${metadata.sqlite};
    INSERT INTO workboard_schema_migrations VALUES ('schema-${metadata.version}', 17);
    INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES ('board', ' {"a":1,"a":2} ', 1, 2);
    ${sql}`,
  );
  return { directory, sourcePath };
}
async function hash(file: string) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}
async function inspectSource(sourcePath: string) {
  using db = openNodeSqliteDatabase(sourcePath, { readOnly: true, readBigInts: true });
  descriptor.inspectSqliteSource?.(db);
  return await inspectDatabasePort({ engine: "sqlite", db }, descriptor);
}

it.each(["agent", "state"])(
  "accepts legal first-use absence in %s inspection and completes only the private copy",
  async (family) => {
    const directory = tempDirs.make("port-first-use-");
    const sourcePath = path.join(directory, "source.sqlite");
    const current = await loadDatabasePortDescriptor(family);
    const table = family === "agent" ? "session_nodes" : "agent_deletion_journal";
    const extraTable = family === "agent" ? table : "agent_database_leases";
    const column = family === "agent" ? "legacy_acp_migration_json" : "phase";
    {
      using db = openNodeSqliteDatabase(sourcePath);
      db.exec([current, ...(current.fragments ?? [])].map((part) => part.sqlite).join("\n;\n"));
      db.exec(`PRAGMA user_version = ${current.version}`);
      if (family === "agent") {
        db.exec(`INSERT INTO schema_meta VALUES ('primary', 'agent', ${current.version}, 'main', NULL, 1, 1);
          ALTER TABLE session_nodes DROP COLUMN legacy_acp_migration_json;
          ALTER TABLE session_key_contract DROP COLUMN canonical_ready;
          INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
          VALUES ('agent:main:main', 'retained-session', '{"sessionId":"retained-session"}', 17);`);
      } else {
        db.exec(`INSERT INTO schema_meta VALUES ('primary', 'global', ${current.version}, NULL, NULL, 1, 1);
          ALTER TABLE worker_workspace_pending_results DROP COLUMN repository_workspace_id;
          ALTER TABLE user_profile_identities DROP COLUMN verified_email_json;
          ALTER TABLE agent_deletion_journal DROP COLUMN phase;
          INSERT INTO agent_deletion_journal (agent_id, agent_dir, workspace_dir, sessions_dir, created_at)
          VALUES ('retired', '/retired/agent', '/retired/workspace', '/retired/sessions', 17);`);
      }
    }
    const original = await hash(sourcePath);
    await expect(inspect(sourcePath)).resolves.toMatchObject({ family, migrationRequired: true });
    const copy = path.join(directory, "private.sqlite");
    await fs.copyFile(sourcePath, copy);
    const prepared = await runDatabasePortTask({ operation: "migrate", sourcePath: copy }, scope);
    expect(prepared.verification.tables[table]?.rows).toBe(1);
    await expect(inspect(copy)).resolves.toMatchObject({
      migrationRequired: false,
      verification: prepared.verification,
    });
    {
      using db = openNodeSqliteDatabase(copy);
      const row =
        family === "agent"
          ? db
              .prepare("SELECT current_session_id, legacy_acp_migration_json FROM session_nodes")
              .get()
          : db.prepare("SELECT agent_id, phase FROM agent_deletion_journal").get();
      expect(row).toEqual(
        family === "agent"
          ? { current_session_id: "retained-session", legacy_acp_migration_json: null }
          : { agent_id: "retired", phase: null },
      );
    }
    expect(await hash(sourcePath)).toBe(original);
    {
      using db = openNodeSqliteDatabase(sourcePath);
      expect(
        db.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name = ?`).get(column),
      ).toBeUndefined();
      db.exec(`ALTER TABLE ${extraTable} ADD COLUMN unported_data TEXT`);
    }
    await expect(inspect(sourcePath)).rejects.toThrow(
      `Unknown or missing columns in ${extraTable}`,
    );
  },
);

it.each([false, true])(
  "skips only empty retained state tables (pending columns: %s)",
  async (pending) => {
    const sourcePath = path.join(tempDirs.make("state-port-retained-"), "openclaw.sqlite");
    const state = await loadStatePortDescriptor();
    {
      using db = openNodeSqliteDatabase(sourcePath);
      db.exec([state, ...(state.fragments ?? [])].map((schema) => schema.sqlite).join("\n;\n"));
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
      INSERT INTO schema_meta VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL, NULL, 1, 1);
      CREATE TABLE fleet_cells (tenant_id TEXT PRIMARY KEY) STRICT;`);
      if (pending) {
        db.exec("ALTER TABLE agent_deletion_journal DROP COLUMN phase");
      }
    }
    const original = await hash(sourcePath);
    await expect(inspect(sourcePath)).resolves.toMatchObject({
      family: "state",
      migrationRequired: pending,
      notes: ["Skipped empty retained SQLite table fleet_cells"],
    });
    expect(await hash(sourcePath)).toBe(original);
    {
      using db = openNodeSqliteDatabase(sourcePath);
      db.exec("INSERT INTO fleet_cells VALUES ('retained')");
    }
    const populated = await hash(sourcePath);
    await expect(inspect(sourcePath)).rejects.toThrow(
      /fleet_cells contains rows.*preserve.*SQLite/i,
    );
    expect(await hash(sourcePath)).toBe(populated);
    {
      using db = openNodeSqliteDatabase(sourcePath);
      db.exec("DELETE FROM fleet_cells; CREATE TABLE unknown_payload (id TEXT)");
    }
    await expect(inspect(sourcePath)).rejects.toThrow("Unknown SQLite table");
  },
);

it.each([25, 27])("preserves the version %s backup shape and Doctor guidance", async (version) => {
  const directory = tempDirs.make("state-port-legacy-");
  const sourcePath = path.join(directory, "openclaw.sqlite");
  const legacy = await loadStatePortDescriptor(version);
  {
    using db = openNodeSqliteDatabase(sourcePath);
    const schemas = [legacy, ...(legacy.fragments ?? [])];
    db.exec(schemas.map((schema) => schema.sqlite).join("\n;\n"));
    db.exec(`PRAGMA user_version = ${version}`);
    for (const prefix of ["", "personal_", "repository_"]) {
      const table = `github_${prefix}publication_requests`;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      expect(columns.some((column) => column.name === "draft")).toBe(false);
      const definition = schemas
        .flatMap((part) => part.tables)
        .find((entry) => entry.name === table);
      expect(definition?.columns.some((column) => column.name === "draft")).toBe(false);
    }
  }
  const original = await hash(sourcePath);
  await expect(inspect(sourcePath)).rejects.toThrow(
    "run openclaw doctor --fix with the matching version first",
  );
  expect(await hash(sourcePath)).toBe(original);
});

it("inspects without writing and refuses changed canonical SQLite data", async () => {
  const { directory, sourcePath } = fixture();
  const original = await hash(sourcePath);
  const before = await fs.readdir(directory);
  const inspected = await inspect(sourcePath);
  expect(inspected).toMatchObject({
    family: "workboard",
    engine: "sqlite",
    version: metadata.version,
    migrationRequired: false,
    verification: { tables: { workboard_boards: { rows: 1 } } },
  });
  expect([await fs.readdir(directory), await hash(sourcePath)]).toEqual([before, original]);
  const targetPath = path.join(directory, "staged.sqlite");
  await fs.copyFile(sourcePath, targetPath);
  assert(inspected.verification);
  using changed = openNodeSqliteDatabase(targetPath);
  changed.exec("UPDATE workboard_boards SET name = 'changed'");
  await expect(
    runDatabasePortTask(
      {
        operation: "verify",
        sourcePath: targetPath,
        config: {},
        engine: "sqlite",
        storeId: "00000000-0000-4000-8000-000000000001",
        namespace: "unused",
        verification: inspected.verification,
      },
      scope,
    ),
  ).rejects.toThrow("changed canonical rows");
  expect(await hash(sourcePath)).toBe(original);
});

it.each([
  ["schema version 99", "PRAGMA user_version = 99"],
  [
    "unknown schema migration",
    "INSERT INTO workboard_schema_migrations VALUES ('future-payload', 1)",
  ],
  ["Unknown SQLite table", "CREATE TABLE private_payload (data TEXT)"],
  ["Unknown or missing columns", "DROP TABLE workboard_worker_protocol"],
  ["invalid UTF-8", "UPDATE workboard_boards SET name = CAST(x'80' AS TEXT)"],
  ["Unknown or missing columns", "ALTER TABLE workboard_boards ADD COLUMN private_payload TEXT"],
  ["unrepresentable UTF-8", "UPDATE workboard_boards SET name = 'private-payload' || char(0)"],
  [
    "database validation",
    "PRAGMA foreign_keys = OFF; INSERT INTO workboard_card_labels VALUES ('absent', 1, 'private-payload')",
  ],
])("refuses %s (%s) without exposing payloads or changing the source", async (message, sql) => {
  const { sourcePath } = fixture(sql);
  const original = await hash(sourcePath);
  const run = message === "database validation" ? inspect : inspectSource;
  const failure = await run(sourcePath).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain(message);
  expect(String(failure)).not.toContain("private-payload");
  expect(await hash(sourcePath)).toBe(original);
});

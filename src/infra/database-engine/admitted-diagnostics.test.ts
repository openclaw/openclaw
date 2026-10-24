import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { revokeSqliteDatabaseAdmissions } from "../sqlite-database-admission.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { describeAdmittedDatabaseStores } from "./admitted-diagnostics.js";
import * as postgresMetadata from "./postgres-store-metadata.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("projects retained SQLite facts and unknowns without reading stores or the filesystem", () => {
  const directory = tempDirs.make("admitted-database-diagnostics-");
  const file = path.join(directory, "state.sqlite");
  using db = openNodeSqliteDatabase(file);
  db.exec(`
    CREATE TABLE schema_meta (version INTEGER);
    CREATE TABLE config_machine_state (key TEXT);
    CREATE TABLE audit_events (id INTEGER);
    PRAGMA user_version = 7;
  `);
  admitSqliteSchema(db);
  using plugin = openNodeSqliteDatabase(path.join(directory, "workboard.sqlite"));
  plugin.exec(
    "CREATE TABLE workboard_schema_migrations (version INTEGER); PRAGMA user_version = 0;",
  );
  admitSqliteSchema(plugin);
  const agentFile = path.join(directory, "openclaw-agent.sqlite");
  const missingAgentDir = path.join(directory, "missing");
  using agent = openNodeSqliteDatabase(agentFile);
  agent.exec(`
    CREATE TABLE schema_meta (version INTEGER);
    CREATE TABLE session_nodes (id TEXT);
    CREATE TABLE transcript_events (id TEXT);
    PRAGMA user_version = 28;
  `);
  admitSqliteSchema(agent);
  const denyProbe = () => {
    throw new Error("Status must not perform a database or filesystem probe");
  };
  vi.spyOn(db, "prepare").mockImplementation(denyProbe);
  vi.spyOn(agent, "prepare").mockImplementation(denyProbe);
  vi.spyOn(fs, "readFileSync").mockImplementation(denyProbe);
  vi.spyOn(fs, "statSync").mockImplementation(denyProbe);
  vi.spyOn(fs, "openSync").mockImplementation(denyProbe);
  vi.spyOn(postgresMetadata, "withPostgresConnection").mockImplementation(denyProbe);
  let rows: ReturnType<typeof describeAdmittedDatabaseStores>;
  try {
    rows = describeAdmittedDatabaseStores({
      database: { engine: "postgres" },
      agents: {
        entries: { main: { agentDir: directory }, missing: { agentDir: missingAgentDir } },
      },
    });
  } finally {
    vi.restoreAllMocks();
  }
  expect(rows.find((row) => row.path === file)).toMatchObject({
    family: "state",
    observed: "sqlite",
    mismatch: true,
    schema: { version: 7, expectedVersion: null, pending: null },
    connectivity: "local",
    custody: "unverifiable",
    lease: "unverifiable",
    backup: null,
    legacyMigrations: { state: "unknown" },
  });
  expect(rows.find((row) => row.path === path.join(directory, "workboard.sqlite"))).toMatchObject({
    observed: "sqlite",
    schema: { versioning: "unknown", version: null, pending: null },
  });
  expect(rows.find((row) => row.path === agentFile)).toMatchObject({
    family: "agent",
    observed: "sqlite",
  });
  expect(
    rows.find((row) => row.path === path.join(missingAgentDir, "openclaw-agent.sqlite")),
  ).toMatchObject({
    observed: "unknown",
    connectivity: "unknown",
    schema: { version: null, pending: null },
    nextSteps: [expect.stringContaining("openclaw doctor")],
  });
  expect(rows.find((row) => row.family === "credentials")).toMatchObject({
    configured: { effective: "sqlite", fixedLocal: true },
    observed: "unknown",
  });
  revokeSqliteDatabaseAdmissions(db);
  expect(describeAdmittedDatabaseStores({}).some((row) => row.path === file)).toBe(false);
});

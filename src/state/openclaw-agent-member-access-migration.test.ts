import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { readSessionMembersInWorker } from "../config/sessions/session-sharing-store.js";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import { readExistingAgentSchemaMeta } from "./openclaw-agent-db-metadata.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "./openclaw-agent-db-schema-compatibility.js";
import { assertAgentSchemaVersion } from "./openclaw-agent-db-schema-helpers.js";
import { assertCurrentAgentSchemaMetadata } from "./openclaw-agent-db-schema-read.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import {
  AGENT_MEMBER_ACCESS_POSTGRES_MIGRATION_SQL,
  withoutAgentPostgresMemberAccess,
} from "./openclaw-agent-member-access-schema.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-schema-history.js";
import { assertOpenClawMigrationWitnessPreserved } from "./openclaw-migration-witness.js";
import {
  agentWitness,
  expectVersion,
  migrationFixture,
  row,
  seedVersion,
} from "./schema-migration.test-support.js";

function seed(database: DatabaseSync) {
  database.exec(getOpenClawAgentMigrationSchema(43));
  seedVersion(database, 43);
  database.exec(`INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at)
      VALUES ('agent:main:test','test','{"sessionId":"test","updatedAt":1,"visibility":"shared","delivery":{"kind":"none"}}',1,1);
    INSERT INTO session_windows(session_id,session_key,created_at,updated_at)
      VALUES ('test','agent:main:test',1,1);
    INSERT INTO transcript_events(session_id,seq,event_json,created_at)
      VALUES ('test',1,'{"type":"message","message":{"role":"user","content":"retained"}}',1);
    INSERT INTO session_members(session_key,identity_id,added_by,added_at) VALUES ('agent:main:test','reader','owner',1);
    INSERT INTO cache_entries(scope,key,blob,updated_at) VALUES ('unrelated','bytes',X'00FF01',1);
    ANALYZE;`);
}
const fixture = migrationFixture({
  seed,
  predecessor: 43,
  target: 44,
  scope: ["schema_meta", "session_members"],
});

it.each(["commit", "rollback"])(
  "migrates member access atomically without changing existing grants (%s)",
  async (outcome) => {
    await fixture("member-access.sqlite", async ({ database, migrate }) => {
      const before = agentWitness(database);
      await migrate(outcome);
      expectVersion(database, outcome === "commit" ? 44 : 43);
      expect(assertOpenClawMigrationWitnessPreserved(before, agentWitness(database))).toEqual({
        warnings: [],
      });
      expect(row(database, "SELECT identity_id,added_by,added_at FROM session_members")).toEqual({
        identity_id: "reader",
        added_by: "owner",
        added_at: 1,
      });
      if (outcome === "commit") {
        expect(row(database, "SELECT access FROM session_members")).toEqual({ access: null });
        const upgraded = agentWitness(database);
        database.exec("UPDATE session_members SET access='suggest'");
        expect(() =>
          assertOpenClawMigrationWitnessPreserved(upgraded, agentWitness(database)),
        ).toThrow(/retained database content: session_members/u);
        expect(() => database.exec("UPDATE session_members SET access='admin'")).toThrow(/CHECK/);
      }
    });
  },
);

it("opens a migrated v43 session through the production engine and sharing reader", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const pathname = resolveOpenClawAgentSqlitePath(options);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    const before = (() => {
      using database = new DatabaseSync(pathname);
      seed(database);
      assertAgentSchemaVersion(
        database,
        { agentId: "main", pathname, version: 43 },
        getOpenClawAgentMigrationSchema(43),
      );
      return agentWitness(database);
    })();
    await withAgentDatabaseMaintenanceLease(options, (maintenance) =>
      migrateOpenClawAgentDatabaseForMaintenance({ ...options, pathname }, maintenance),
    );
    const database = openOpenClawAgentDatabase(options);
    const native = requireNativeSqliteDatabase(database.db);
    expectVersion(native, agentEngineSchema.version);
    expect(assertOpenClawMigrationWitnessPreserved(before, agentWitness(native))).toEqual({
      warnings: [],
    });
    expect(row(native, "SELECT access FROM session_members")).toEqual({ access: null });
    const scope = { ...options, sessionKey: "agent:main:test" };
    const members = { identityId: "reader", addedBy: "owner", addedAt: 1 };
    const first = await readSessionMembersInWorker(scope);
    expect(first).toMatchObject({
      entry: { sessionId: "test", updatedAt: 1, visibility: "shared" },
      members: [members],
    });
    expect(first.members).toEqual([members]);
    await closeOpenClawAgentDatabasesAsync();
    expect(await readSessionMembersInWorker(scope)).toEqual(first);
  });
});

it("keeps the v43 reader floor when the real v44 member-access migration commits", async () => {
  const base = getOpenClawAgentMigrationSchema(43);
  await fixture("member-downgrade.sqlite", async ({ database, migrate }) => {
    const before = row(database, "SELECT identity_id,added_by,added_at FROM session_members");
    await migrate();
    expectVersion(database, 44);
    const metadata = readExistingAgentSchemaMeta(database);
    expect(metadata?.minReader).toBe(43);
    expect(() => assertCurrentAgentSchemaMetadata(metadata, "main", "fixture", 43)).not.toThrow();
    expect(collectSqliteSchemaIssues(database, base, AGENT_SCHEMA_COMPATIBILITY)).toEqual([]);
    expect(row(database, "SELECT identity_id,added_by,added_at FROM session_members")).toEqual(
      before,
    );
    database.exec(
      "INSERT INTO session_members (session_key,identity_id,added_by,added_at) VALUES ('agent:main:test','old-reader','owner',2)",
    );
    expect(
      row(database, "SELECT access FROM session_members WHERE identity_id='old-reader'"),
    ).toEqual({
      access: null,
    });
  });
});

it("restores the scoped predecessor backup while preserving unrelated writes", async () => {
  await fixture(
    "member-restore.sqlite",
    async ({ restore, database }) => {
      await restore(() => ({
        table: row(database, "SELECT sql FROM sqlite_schema WHERE name='session_members'"),
        member: row(database, "SELECT * FROM session_members"),
        version: row(database, "PRAGMA user_version"),
      }));
    },
    "state",
  );
});

it("registers an exact consecutive PostgreSQL migration", () => {
  const step = agentEngineSchema.postgresMigrations?.find((migration) => migration.version === 44);
  expect(withoutAgentPostgresMemberAccess(agentEngineSchema.postgres)).not.toContain(
    '"access" text COLLATE "C",',
  );
  expect(step?.minReader).toBe(43);
  expect(AGENT_MEMBER_ACCESS_POSTGRES_MIGRATION_SQL).toBe(
    `ALTER TABLE session_members ADD COLUMN access TEXT COLLATE "C" CHECK (access IS NULL OR access IN ('read', 'suggest', 'send'));`,
  );
  expect(step?.sql).toContain("ALTER TABLE session_members ADD COLUMN access");
});

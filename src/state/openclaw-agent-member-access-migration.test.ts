import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";
import { assertAgentSchemaVersion } from "./openclaw-agent-db-schema-helpers.js";
import { withoutAgentPostgresMemberAccess } from "./openclaw-agent-member-access-schema.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-schema-history.js";
import {
  expectVersion,
  migrationFixture,
  row,
  seedVersion,
} from "./schema-migration.test-support.js";

function seed(database: DatabaseSync) {
  database.exec(getOpenClawAgentMigrationSchema(43));
  seedVersion(database, 43);
  database.exec(`INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES ('agent:main:test','test','{}',1);
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
      await migrate(outcome);
      expectVersion(database, outcome === "commit" ? 44 : 43);
      expect(row(database, "SELECT identity_id,added_by,added_at FROM session_members")).toEqual({
        identity_id: "reader",
        added_by: "owner",
        added_at: 1,
      });
      if (outcome === "commit") {
        expect(row(database, "SELECT access FROM session_members")).toEqual({ access: null });
        database.exec("UPDATE session_members SET access='suggest'");
        expect(() => database.exec("UPDATE session_members SET access='admin'")).toThrow(/CHECK/);
      }
    });
  },
);

it("refuses the base build's exact table contract even if the version markers are held back", async () => {
  // Pin the complete v43 DDL from da816e2 without requiring Git history in shallow CI checkouts.
  const base = getOpenClawAgentMigrationSchema(43);
  expect(createHash("sha256").update(base).digest("hex")).toBe(
    "dbfb977f921cbd823f4c51fd2d33f1d5bca0d09e35dfaf3f148b0ac6e11a38cb",
  );
  await fixture("member-downgrade.sqlite", async ({ database, migrate }) => {
    assertAgentSchemaVersion(database, { agentId: "main", pathname: "fixture", version: 43 }, base);
    await migrate();
    expect(() =>
      assertAgentSchemaVersion(
        database,
        { agentId: "main", pathname: "fixture", version: 43 },
        base,
      ),
    ).toThrow(/version 43/);
    database.exec("PRAGMA user_version=43; UPDATE schema_meta SET schema_version=43");
    expect(() =>
      assertAgentSchemaVersion(
        database,
        { agentId: "main", pathname: "fixture", version: 43 },
        base,
      ),
    ).toThrow(/session_members/);
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
  expect(step).toBeDefined();
  expect(withoutAgentPostgresMemberAccess(agentEngineSchema.postgres)).not.toContain(
    '"access" text COLLATE "C",',
  );
  expect(step?.sql).toContain("ALTER TABLE session_members ADD COLUMN access");
});

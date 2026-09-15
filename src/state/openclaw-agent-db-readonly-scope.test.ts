import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "./openclaw-agent-db-lifecycle.js";
import {
  OpenClawAgentDatabaseReadOnlyScope,
  withOpenClawAgentDatabaseReadOnly,
} from "./openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";

it("keeps one connection while nested reads retain independent committed snapshots", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const { path } = openOpenClawAgentDatabase(options);
    await closeOpenClawAgentDatabaseByPathAsync(path);
    const target = { agentId: "main", path };
    const scope = new OpenClawAgentDatabaseReadOnlyScope();
    const writer = new (requireNodeSqlite().DatabaseSync)(path);
    let retained: DatabaseSync | undefined;
    const query = "SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'";
    try {
      scope.run(target, () => {
        const first = withOpenClawAgentDatabaseReadOnly(({ db }) => {
          retained = db;
          return db.prepare(query).get();
        }, options);
        expect(first.found).toBe(true);
        expect(retained?.isOpen).toBe(true);
        withOpenClawAgentDatabaseReadOnly(({ db }) => {
          expect(db).toBe(retained);
          db.exec("BEGIN DEFERRED");
          try {
            const before = db.prepare(query).get();
            writer
              .prepare(
                "UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'",
              )
              .run();
            const committed = writer.prepare(query).get();
            expect(committed).not.toEqual(before);
            const nested = withOpenClawAgentDatabaseReadOnly(({ db: inner }) => {
              expect(inner).not.toBe(db);
              return inner.prepare(query).get();
            }, options);
            expect(nested).toEqual({ found: true, value: committed });
            expect(db.prepare(query).get()).toEqual(before);
          } finally {
            db.exec("ROLLBACK");
          }
        }, options);
        expect(
          withOpenClawAgentDatabaseReadOnly(({ db }) => db.prepare(query).get(), options),
        ).toEqual({ found: true, value: writer.prepare(query).get() });
      });
    } finally {
      writer.close();
      scope.close();
    }
    expect(retained?.isOpen).toBe(false);
  });
});

it.each([
  {
    sql: `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`,
    error: "newer schema version",
  },
  {
    sql: `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}`,
    error: "run openclaw doctor --fix",
  },
  {
    sql: "UPDATE schema_meta SET agent_id = 'another' WHERE meta_key = 'primary'",
    error: "belongs to agent another",
  },
  {
    sql: "UPDATE schema_meta SET role = 'state' WHERE meta_key = 'primary'",
    error: "has schema role state",
  },
])("revalidates retained read admission after a committed change: $sql", async ({ sql, error }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const { path } = openOpenClawAgentDatabase(options);
    await closeOpenClawAgentDatabaseByPathAsync(path);
    const target = { agentId: "main", path };
    const scope = new OpenClawAgentDatabaseReadOnlyScope();
    const read = () =>
      scope.run(target, () => withOpenClawAgentDatabaseReadOnly(() => "admitted", options));
    try {
      expect(read()).toEqual({ found: true, value: "admitted" });
      const writer = new (requireNodeSqlite().DatabaseSync)(path);
      try {
        writer.exec(sql);
      } finally {
        writer.close();
      }
      expect(read).toThrow(error);
    } finally {
      scope.close();
    }
  });
});

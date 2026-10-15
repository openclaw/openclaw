import { expect, it } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import { runSessionStartupMigration } from "./startup-migration.js";

it("reuses certified run outcomes after restart and repairs outcomes imported afterward", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async ({ env, writeConfig }) => {
    const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
    await writeConfig(cfg);
    const options = { agentId: "main", env };
    const keys = ["agent:main:retained-a", "agent:main:retained-b"];
    for (const [index, sessionKey] of keys.entries()) {
      replaceSessionEntrySync(
        { ...options, sessionKey },
        { sessionId: `retained-${index}`, updatedAt: 100, label: `Retained ${index}` },
      );
    }
    const startup = () => runSessionStartupMigration({ cfg, env, log: { info() {}, warn() {} } });
    await startup();
    await closeOpenClawAgentDatabasesAsync();

    const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      await startup();
    } finally {
      reads.restore();
    }
    // Certified stores must not reparse every entry to rediscover retired outcomes.
    expect(reads.queries.filter((query) => /json_each\(entry_json\)/iu.test(query))).toEqual([]);
    expect(loadSessionEntry({ ...options, sessionKey: keys[0]! })).toMatchObject({
      sessionId: "retained-0",
      updatedAt: 100,
      label: "Retained 0",
    });

    // Offline import owns raw legacy bytes and revokes canonical proof before release.
    runOpenClawAgentWriteTransaction((database) => {
      for (const [index, sessionKey] of keys.entries()) {
        database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
          JSON.stringify({
            sessionId: `retained-${index}`,
            updatedAt: 100,
            label: `Imported ${index}`,
            status: index === 0 ? "running" : "queued",
          }),
          sessionKey,
        );
      }
      markCanonicalSessionValidationPending(database, keys);
    }, options);
    await startup();
    for (const [index, sessionKey] of keys.entries()) {
      expect(loadSessionEntry({ ...options, sessionKey })).toMatchObject({
        sessionId: `retained-${index}`,
        updatedAt: 100,
        label: `Imported ${index}`,
        status: "interrupted",
        abortedLastRun: true,
        endedAt: 100,
      });
    }
    const database = openOpenClawAgentDatabase(options);
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS count FROM session_canonical_validation_pending")
        .get(),
    ).toMatchObject({ count: 0 });
  });
});

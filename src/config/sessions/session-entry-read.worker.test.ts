import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readSessionBackingFacts } from "./session-backing-facts.js";
import { captureCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { readExactSessionEntriesWithLifecycle } from "./session-entry-read.worker.js";

it("publishes exact-read admission only after commit and reuses it on the retained reader", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:cron:admission";
    writeSessionEntry(database, sessionKey, { sessionId: "admitted-session", updatedAt: 1 });
    const target = { agentId: database.agentId, path: database.path };
    await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
    const retained = new OpenClawAgentDatabaseReadOnlyScope();
    try {
      retained.run(target, () => {
        const opened = withOpenClawAgentDatabaseReadOnly((reader) => reader, { ...target, env });
        if (!opened.found) {
          throw new Error("Expected the seeded read-only database");
        }
        const reader = opened.value;
        const read = () =>
          readExactSessionEntriesWithLifecycle({
            kind: "session-exact-entries",
            database: target,
            env,
            sessionKeys: [sessionKey],
          });
        const commitFailure = new Error("Injected snapshot commit failure");
        const exec = reader.db.exec.bind(reader.db);
        const failingCommit = vi.spyOn(reader.db, "exec").mockImplementation((sql) => {
          if (sql === "COMMIT") {
            throw commitFailure;
          }
          return exec(sql);
        });
        try {
          expect(read).toThrow(commitFailure);
          expect(reader.db.isTransaction).toBe(false);
          expect(captureCanonicalSessionReaderContinuation(reader)).toBeUndefined();
        } finally {
          failingCommit.mockRestore();
        }
        const queries = trackSqliteStatementExecutions(reader.db, ["validation"], (sql) =>
          sql.includes("retained_window") ||
          sql.includes('from "session_canonical_validation_pending"')
            ? "validation"
            : null,
        );
        try {
          expect(read().entries[0]?.entry.sessionId).toBe("admitted-session");
          expect(queries.counts.validation).toBeGreaterThan(0);
          const admission = captureCanonicalSessionReaderContinuation(reader);
          expect(admission).toBeDefined();
          admission?.release();
          queries.counts.validation = 0;
          expect(read().entries[0]?.entry.sessionId).toBe("admitted-session");
          expect(queries.counts.validation).toBe(0);
        } finally {
          queries.restore();
        }
      });
    } finally {
      retained.close();
    }
  });
});

it.each(["worker", "synchronous"] as const)(
  "refuses unavailable backing metadata in the %s reader instead of reporting missing sessions",
  async (reader) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
      const sessionKeys = ["agent:main:subagent:retained"];
      const read = () =>
        reader === "worker"
          ? readExactSessionEntriesWithLifecycle({
              kind: "session-exact-entries",
              database: { agentId: "main", path: storePath },
              env,
              sessionKeys,
              projection: "backing",
            }).entries
          : readSessionBackingFacts({ storePath, sessionKeys, env });
      expect(read()).toEqual([]);
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, "");
      expect(read).toThrow("Session metadata unavailable (schema-missing)");
    });
  },
);

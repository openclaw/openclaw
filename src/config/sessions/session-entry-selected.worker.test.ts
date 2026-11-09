import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readSessionEntryList } from "./session-entry-list.worker.js";

it.each(["list", "full"] as const)(
  "hydrates only requested %s entries through the listing worker owner",
  async (projection) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const target = { agentId: database.agentId, path: database.path };
      const selected = ["agent:main:a-selected", "agent:main:z-selected"] as const;
      const prompt = "synthetic saved prompt".repeat(128);
      const hidden = "agent:main:internal-session-effects:selected";
      runOpenClawAgentWriteTransaction(
        () => {
          for (const sessionKey of selected) {
            writeSessionEntry(database, sessionKey, {
              sessionId: sessionKey,
              updatedAt: 1,
              skillsSnapshot: { prompt, skills: [] },
            });
          }
          for (let index = 0; index < 32; index++) {
            writeSessionEntry(database, `agent:main:unrelated-${index}`, {
              sessionId: `unrelated-${index}`,
              updatedAt: 1,
              skillsSnapshot: { prompt, skills: [] },
            });
          }
          writeSessionEntry(database, hidden, { sessionId: "hidden", updatedAt: 1 });
          database.db
            .prepare(
              "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count) VALUES (?, ?, ?, 1)",
            )
            .run(selected[0], JSON.stringify({ type: "profile" }), "selected-member");
        },
        { ...target, env },
      );
      const retained = new OpenClawAgentDatabaseReadOnlyScope();
      try {
        retained.run(target, () => {
          const opened = withOpenClawAgentDatabaseReadOnly((reader) => reader, { ...target, env });
          if (!opened.found) {
            throw new Error("Expected the admitted listing reader");
          }
          // Admission precedes observation. No listing has populated its snapshot cache.
          const sql = trackSqliteStatementExecutions(opened.value.db, ["entries"], (query) =>
            query.includes('from "session_nodes"') &&
            (query.includes('"entry_json"') || query.startsWith("select *"))
              ? "entries"
              : null,
          );
          const parsed = vi.spyOn(JSON, "parse");
          try {
            const read = (sessionKeys: readonly string[], includeParticipants = true) =>
              readSessionEntryList({
                kind: "session-entry-list",
                database: target,
                scope: {
                  agentId: "main",
                  storePath: target.path,
                  env,
                  projection,
                  sessionKeys,
                  includeParticipants,
                },
              });
            const result = read([
              selected[1]!,
              "agent:main:missing",
              selected[0]!,
              selected[1]!,
              hidden,
            ]);
            expect(result.entries.map(({ sessionKey }) => sessionKey)).toEqual(selected);
            expect(result.source).toMatchObject(target);
            expect(result.entries[0]?.entry).toMatchObject({
              participants: [{ identity: { type: "profile", id: "selected-member" } }],
              participantCount: 1,
            });
            expect(result.entries[0]?.entry.skillsSnapshot).toEqual(
              projection === "full" ? { prompt, skills: [] } : undefined,
            );
            expect(
              parsed.mock.calls.filter(([json]) => json.includes('"sessionId":"unrelated-')),
            ).toHaveLength(0);
            // Two visible rows plus the explicitly selected internal row, never 32 siblings.
            expect(sql.rowCounts.entries).toBe(3);
            const priorRows = sql.rowCounts.entries;
            expect(read([]).entries).toEqual([]);
            expect(sql.rowCounts.entries).toBe(priorRows);
            expect(read([selected[0]!], false).entries[0]?.entry.participants).toBeUndefined();
          } finally {
            parsed.mockRestore();
            sql.restore();
          }
        });
      } finally {
        retained.close();
      }
    });
  },
);

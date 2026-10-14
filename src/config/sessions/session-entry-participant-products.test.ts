import { StatementSync } from "node:sqlite";
import { expect, it } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { listSessionEntriesCore } from "./session-accessor.entry.js";
import {
  prepareExactSessionEntryRowReads,
  readSessionChildEntriesInDatabase,
} from "./session-accessor.sqlite-entry-read.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";

it.each(["cohort", "children"] as const)(
  "reuses participant products for %s and observes committed participants",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const parent = "agent:main:parent";
      const sessionKey = "agent:main:child";
      const siblingKey = "agent:main:sibling";
      const scope = { agentId: "main", env, sessionKey };
      replaceSessionEntrySync(scope, {
        sessionId: "child",
        updatedAt: 1,
        parentSessionKey: parent,
      });
      replaceSessionEntrySync(
        { ...scope, sessionKey: siblingKey },
        { sessionId: "sibling", updatedAt: 1, parentSessionKey: parent },
      );
      recordSessionParticipant(scope, { identity: { type: "agent", id: "first" }, promptedAt: 1 });
      const database = openOpenClawAgentDatabase(scope);
      const read = () =>
        mode === "cohort"
          ? prepareExactSessionEntryRowReads(database, [sessionKey, siblingKey], "list")(sessionKey)
              ?.entry
          : readSessionChildEntriesInDatabase(database, parent, "list")[0]?.entry;
      listSessionEntriesCore({ ...scope, projection: "list" });
      const sql = observeSqliteReadSql(StatementSync.prototype);
      try {
        const first = read();
        expect(first?.participants).toEqual([{ identity: { type: "agent", id: "first" } }]);
        expect(
          sql.queries.filter((query) => query.includes('from "session_participants"')),
        ).toEqual([]);
        first!.participants![0]!.identity.id = "caller-owned";
        expect(read()?.participants?.[0]?.identity.id).toBe("first");
        recordSessionParticipant(scope, {
          identity: { type: "agent", id: "second" },
          promptedAt: 2,
        });
        expect(read()?.participants).toEqual([
          { identity: { type: "agent", id: "first" } },
          { identity: { type: "agent", id: "second" } },
        ]);
      } finally {
        sql.restore();
      }
    });
  },
);

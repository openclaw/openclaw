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
      for (const sessionId of ["child", "sibling"]) {
        replaceSessionEntrySync(
          { ...scope, sessionKey: `agent:main:${sessionId}` },
          { sessionId, updatedAt: 1, parentSessionKey: parent },
        );
      }
      const participant = (id: string) => ({ identity: { type: "agent" as const, id } });
      const record = (id: string, promptedAt: number) =>
        recordSessionParticipant(scope, { ...participant(id), promptedAt });
      record("first", 1);
      const database = openOpenClawAgentDatabase(scope);
      const read = () =>
        mode === "cohort"
          ? prepareExactSessionEntryRowReads(database, [sessionKey, siblingKey], "list")(sessionKey)
              ?.entry
          : readSessionChildEntriesInDatabase(database, parent, "list")[0]?.entry;
      listSessionEntriesCore({ ...scope, projection: "list" });
      const sql = observeSqliteReadSql(StatementSync.prototype);
      using _ = { [Symbol.dispose]: sql.restore };
      const first = read();
      expect(first?.participants).toEqual([participant("first")]);
      expect(sql.queries.filter((query) => query.includes('from "session_participants"'))).toEqual(
        [],
      );
      first!.participants![0]!.identity.id = "caller-owned";
      expect(read()?.participants?.[0]?.identity.id).toBe("first");
      record("second", 2);
      expect(read()?.participants).toEqual([participant("first"), participant("second")]);
    });
  },
);

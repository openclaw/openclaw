import path from "node:path";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import {
  searchSessionTranscripts,
  searchSessionTranscriptsReadOnlySync,
} from "./session-transcript-search.js";

it("keeps scoped search bytes while disk SQL executes outside the caller thread", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.stateDir, "search.sqlite");
    const scope = { agentId: "main", env: state.env, storePath };
    for (const sessionKey of ["agent:main:selected", "agent:main:excluded"]) {
      await replaceTranscriptEvents({ ...scope, sessionKey, sessionId: sessionKey }, [
        { type: "session", id: sessionKey, version: 3 },
        ...Array.from({ length: 2 }, (_, index) => ({
          type: "message" as const,
          id: `message-${index}`,
          parentId: index === 0 ? null : "message-0",
          timestamp: index + 1,
          message: { role: "assistant", content: `Needle visible text ${index}` },
        })),
      ]);
    }
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      env: state.env,
      path: storePath,
    });
    const request = { ...scope, query: "needle", sessionKeys: ["agent:main:selected"], limit: 1 };
    const database = { agentId: "main", path: storePath };
    const golden = searchSessionTranscriptsReadOnlySync(request, { ...database, env: state.env });
    expect(golden).toMatchObject({
      hits: [
        {
          sessionKey: "agent:main:selected",
          messageId: "message-1",
          snippet: "Needle visible text 1",
        },
      ],
      indexing: false,
      truncated: true,
    });
    const hostSql = observeHostDataSql(state.env);
    try {
      const actual = await searchSessionTranscripts(request, database);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(golden));
      expect(hostSql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      hostSql.restore();
    }
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db).deleteFrom("session_transcript_index_state"),
        );
      },
      { ...database, env: state.env },
    );
    expect((await searchSessionTranscripts(request, database)).indexing).toBe(true);
    await waitForSessionTranscriptIndexReconcile({ ...database, env: state.env });
    expect(JSON.stringify(await searchSessionTranscripts(request, database))).toBe(
      JSON.stringify(golden),
    );
  });
});

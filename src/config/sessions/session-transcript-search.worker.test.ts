import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import * as projectionWriter from "./session-transcript-projection-writer.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
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
    const {
      found,
      revision: _revision,
      ...golden
    } = searchSessionTranscriptsReadOnlySync(request, {
      ...database,
      env: state.env,
    });
    expect(found).toBe(true);
    expect(golden).toMatchObject({
      hits: [
        {
          sessionKey: "agent:main:selected",
          messageId: "message-1",
          snippet: "Needle visible text 1",
        },
      ],
      truncated: true,
    });
    const hostSql = observeHostDataSql();
    try {
      const actual = await searchSessionTranscripts(request, database);
      expect(actual).toEqual({ ...golden, indexing: false });
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
    expect(await searchSessionTranscripts(request, database)).toEqual({
      ...golden,
      indexing: false,
    });

    const unavailableStatus = vi
      .spyOn(projectionWriter, "readSessionTranscriptIndexStatus")
      .mockRejectedValueOnce(new Error("projection writer unavailable"));
    try {
      expect(await searchSessionTranscripts(request, database)).toEqual({
        ...golden,
        indexing: true,
      });
      expect(unavailableStatus).toHaveBeenCalledTimes(1);
      expect(isSessionTranscriptIndexReconcileRunning({ ...database, env: state.env })).toBe(false);
    } finally {
      unavailableStatus.mockRestore();
    }

    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("session_transcript_index_state")
            .set({ needs_rebuild: 1 }),
        );
      },
      { ...database, env: state.env },
    );
    const readStatus = projectionWriter.readSessionTranscriptIndexStatus;
    const status = vi
      .spyOn(projectionWriter, "readSessionTranscriptIndexStatus")
      .mockImplementationOnce(async (...args) => {
        // Complete publication after the hit snapshot but before its clean status is read.
        await reconcileSessionTranscriptIndexes({ ...database, env: state.env });
        const pending = await readStatus(...args);
        expect(pending).toBe(false);
        expect(isSessionTranscriptIndexReconcileRunning({ ...database, env: state.env })).toBe(
          false,
        );
        return pending;
      });
    try {
      expect(await searchSessionTranscripts(request, database)).toMatchObject({
        hits: [],
        indexing: true,
      });
    } finally {
      status.mockRestore();
    }
    expect(await searchSessionTranscripts(request, database)).toEqual({
      ...golden,
      indexing: false,
    });
  });
});

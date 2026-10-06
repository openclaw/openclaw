import { afterAll, describe, expect, it } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import { rotateTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { appendTranscriptEvent } from "./session-accessor.sqlite-transcript-write.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  claimPreparedSessionTranscriptProjectionInTransaction,
  deletePreparedSessionTranscriptProjectionChunkInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  prepareSessionTranscriptProjection,
  type PreparedSessionTranscriptProjection,
} from "./session-transcript-projection-rebuild.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-projection-catchup-");

async function prepareDirtyProjection(label: string) {
  const stateDir = sessionDirs.make();
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    sessionId: `projection-catchup-${label}`,
    sessionKey: `agent:main:projection-catchup-${label}`,
  };
  const databaseOptions = { agentId: scope.agentId, env: scope.env };
  if (label === "invalid-leaf") {
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "invalid-leaf",
      parentId: null,
      targetId: "missing",
    });
  } else {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "root", parentId: null, message: { role: "user", content: "root" } }],
      touchSessionEntry: false,
    });
  }
  const database = openOpenClawAgentDatabase(databaseOptions);
  database.db
    .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
    .run(scope.sessionId);
  const plan = prepareSessionTranscriptProjection(database.db, scope.sessionId);
  if (!plan) {
    throw new Error("missing prepared projection");
  }
  return { database, databaseOptions, plan, scope };
}

function publishPreparedBase(params: {
  claimId: number;
  databaseOptions: { agentId: string; env: NodeJS.ProcessEnv };
  plan: PreparedSessionTranscriptProjection;
  sessionId: string;
}) {
  expect(
    runOpenClawAgentWriteTransaction(
      (database) =>
        claimPreparedSessionTranscriptProjectionInTransaction(
          database.db,
          params.plan,
          params.claimId,
        ),
      params.databaseOptions,
    ),
  ).toBe(true);
  expect(
    runOpenClawAgentWriteTransaction((database) => {
      const deleted = deletePreparedSessionTranscriptProjectionChunkInTransaction(database.db, {
        claimId: params.claimId,
        maxRowsPerTable: 512,
        sessionId: params.sessionId,
      });
      expect(deleted).toEqual({ hasMore: false, owned: true });
      return appendPreparedSessionTranscriptProjectionChunkInTransaction(database.db, {
        activeRows: params.plan.activeRows,
        claimId: params.claimId,
        ftsRows: params.plan.ftsRows,
        sessionId: params.sessionId,
      });
    }, params.databaseOptions),
  ).toBe(true);
}

describe("session transcript projection append catch-up", () => {
  it.each(["invalid-leaf", "oversized"])(
    "refuses an unsafe $0 catch-up before replacing the projection",
    async (label) => {
      const fixture = await prepareDirtyProjection(label);
      if (label === "invalid-leaf") {
        expect(fixture.plan.sourceHasInvalidLeafControl).toBe(true);
        await persistSessionTranscriptTurn(fixture.scope, {
          messages: [
            {
              eventId: "racing-continuation",
              parentId: null,
              message: { role: "assistant", content: "arrived after preparation" },
            },
          ],
          touchSessionEntry: false,
        });
      } else {
        runOpenClawAgentWriteTransaction((database) => {
          appendTranscriptEventInTransaction(
            database,
            fixture.scope,
            {
              type: "message",
              id: "oversized-tail",
              parentId: "root",
              message: { role: "assistant", content: "x".repeat(257 * 1024) },
            },
            { scheduleProjectionReconcile: false },
          );
        }, fixture.databaseOptions);
      }
      expect(
        runOpenClawAgentWriteTransaction(
          (database) =>
            claimPreparedSessionTranscriptProjectionInTransaction(database.db, fixture.plan, -41),
          fixture.databaseOptions,
        ),
      ).toBe(false);
    },
  );

  it.each(["append", "reset", "branch", "generation"])(
    "finalizes only an append-only source change (%s)",
    async (label) => {
      const fixture = await prepareDirtyProjection(label);
      if (label === "append") {
        runOpenClawAgentWriteTransaction((database) => {
          for (let index = 0; index < 10; index++) {
            appendTranscriptEventInTransaction(
              database,
              fixture.scope,
              {
                type: "message",
                id: `racing-append-${index}`,
                parentId: index === 0 ? "root" : `racing-append-${index - 1}`,
                message: { role: "assistant", content: `arrived after preparation ${index}` },
              },
              { scheduleProjectionReconcile: false },
            );
          }
        }, fixture.databaseOptions);
      }
      const claimId = -44;
      publishPreparedBase({
        claimId,
        databaseOptions: fixture.databaseOptions,
        plan: fixture.plan,
        sessionId: fixture.scope.sessionId,
      });
      runOpenClawAgentWriteTransaction((database) => {
        if (label === "generation") {
          rotateTranscriptGenerationInTransaction(database, fixture.scope.sessionId);
        } else if (label !== "append") {
          appendTranscriptEventInTransaction(
            database,
            fixture.scope,
            label === "reset"
              ? { type: "reset", id: "racing-reset", parentId: "root", firstKeptEntryId: "root" }
              : {
                  type: "message",
                  id: "racing-branch",
                  parentId: null,
                  message: { role: "assistant", content: "branch" },
                },
            { scheduleProjectionReconcile: false },
          );
        }
        expect(
          finalizePreparedSessionTranscriptProjectionInTransaction(
            database.db,
            fixture.plan,
            claimId,
          ),
        ).toBe(label === "append");
      }, fixture.databaseOptions);
      if (label === "append") {
        expect(
          fixture.database.db
            .prepare(
              "SELECT indexed_seq, needs_rebuild, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get(fixture.scope.sessionId),
        ).toEqual({
          active_message_count: 11,
          indexed_seq: fixture.plan.sourceIndexedSeq + 10,
          needs_rebuild: 0,
        });
        return;
      }
      expect(
        fixture.database.db
          .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
          .get(fixture.scope.sessionId),
      ).toEqual({ needs_rebuild: 1 });
    },
  );
});

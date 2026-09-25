import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function prepareDirtyProjection(label: string) {
  const stateDir = tempDirs.make(`openclaw-projection-catchup-${label}-`);
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    sessionId: `projection-catchup-${label}`,
    sessionKey: `agent:main:projection-catchup-${label}`,
  };
  const databaseOptions = { agentId: scope.agentId, env: scope.env };
  await persistSessionTranscriptTurn(scope, {
    messages: [{ eventId: "root", parentId: null, message: { role: "user", content: "root" } }],
    touchSessionEntry: false,
  });
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
  it("rejects catch-up when the prepared source contains an unresolved leaf control", async () => {
    const stateDir = tempDirs.make("openclaw-projection-catchup-invalid-leaf-");
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "projection-catchup-invalid-leaf",
      sessionKey: "agent:main:projection-catchup-invalid-leaf",
    };
    const databaseOptions = { agentId: scope.agentId, env: scope.env };
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "invalid-leaf",
      parentId: null,
      targetId: "missing",
    });
    const database = openOpenClawAgentDatabase(databaseOptions);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    const plan = prepareSessionTranscriptProjection(database.db, scope.sessionId);
    if (!plan) {
      throw new Error("missing prepared projection");
    }
    expect(plan.sourceHasInvalidLeafControl).toBe(true);

    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "racing-continuation",
          parentId: null,
          message: { role: "assistant", content: "arrived after preparation" },
        },
      ],
      touchSessionEntry: false,
    });

    expect(
      runOpenClawAgentWriteTransaction(
        (writeDatabase) =>
          claimPreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan, -41),
        databaseOptions,
      ),
    ).toBe(false);
  });

  it("publishes a bounded append-only tail that lands after preparation", async () => {
    const fixture = await prepareDirtyProjection("append");
    runOpenClawAgentWriteTransaction((database) => {
      for (let index = 0; index < 10; index += 1) {
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

    const claimId = -42;
    publishPreparedBase({
      claimId,
      databaseOptions: fixture.databaseOptions,
      plan: fixture.plan,
      sessionId: fixture.scope.sessionId,
    });
    expect(
      runOpenClawAgentWriteTransaction(
        (database) =>
          finalizePreparedSessionTranscriptProjectionInTransaction(
            database.db,
            fixture.plan,
            claimId,
          ),
        fixture.databaseOptions,
      ),
    ).toBe(true);
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
  });

  it("rejects an oversized append tail before replacing the existing projection", async () => {
    const fixture = await prepareDirtyProjection("oversized");
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

    expect(
      runOpenClawAgentWriteTransaction(
        (database) =>
          claimPreparedSessionTranscriptProjectionInTransaction(database.db, fixture.plan, -43),
        fixture.databaseOptions,
      ),
    ).toBe(false);
  });

  it.each([
    {
      label: "reset",
      append: {
        type: "reset",
        id: "racing-reset",
        parentId: "root",
        firstKeptEntryId: "root",
      },
    },
    {
      label: "branch",
      append: {
        type: "message",
        id: "racing-branch",
        parentId: null,
        message: { role: "assistant", content: "branch" },
      },
    },
  ])(
    "keeps the projection dirty when a $label lands after complete base publication",
    async ({ label, append }) => {
      const fixture = await prepareDirtyProjection(label);
      const claimId = -44;
      publishPreparedBase({
        claimId,
        databaseOptions: fixture.databaseOptions,
        plan: fixture.plan,
        sessionId: fixture.scope.sessionId,
      });
      runOpenClawAgentWriteTransaction((database) => {
        appendTranscriptEventInTransaction(database, fixture.scope, append, {
          scheduleProjectionReconcile: false,
        });
        expect(
          finalizePreparedSessionTranscriptProjectionInTransaction(
            database.db,
            fixture.plan,
            claimId,
          ),
        ).toBe(false);
      }, fixture.databaseOptions);
      expect(
        fixture.database.db
          .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
          .get(fixture.scope.sessionId),
      ).toEqual({ needs_rebuild: 1 });
    },
  );

  it("keeps the projection dirty when the generation changes after complete base publication", async () => {
    const fixture = await prepareDirtyProjection("generation");
    const claimId = -45;
    publishPreparedBase({
      claimId,
      databaseOptions: fixture.databaseOptions,
      plan: fixture.plan,
      sessionId: fixture.scope.sessionId,
    });
    runOpenClawAgentWriteTransaction((database) => {
      rotateTranscriptGenerationInTransaction(database, fixture.scope.sessionId);
      expect(
        finalizePreparedSessionTranscriptProjectionInTransaction(
          database.db,
          fixture.plan,
          claimId,
        ),
      ).toBe(false);
    }, fixture.databaseOptions);
    expect(
      fixture.database.db
        .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
        .get(fixture.scope.sessionId),
    ).toEqual({ needs_rebuild: 1 });
  });
});

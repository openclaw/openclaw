import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { readSessionPendingInputByKey } from "./session-accessor.sqlite-pending-inputs.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";
import { createSessionCompoundWorkerFixture as fixture } from "./session-compound-worker.test-support.js";
import { acquireSessionInputActor, bindUserTurnInputActor } from "./session-input-actor.js";
import { withSessionTranscriptSourcePublication } from "./transcript-write-context.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("retains actor-bound recorder custody through a durable worker publication failure", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const input = await acquireSessionInputActor(
      { agentId: f.scope.agentId, storePath: f.scope.storePath, target: f.target },
      { assertCurrent() {}, assertReadable() {} },
    );
    if (!input) {
      throw new Error("Durable input must acquire a session actor");
    }
    const failure = new Error("durable input publication failed");
    const message = {
      role: "user" as const,
      content: "Keep the worker's committed input.",
      timestamp: 1,
      idempotencyKey: "durable-actor:user",
    };
    const recorder = createUserTurnTranscriptRecorder({
      message,
      target: { ...f.scope, expectedSessionId: f.scope.sessionId, sessionEntry: f.read() },
      updateMode: "none",
      onPersistenceError() {},
    });
    bindUserTurnInputActor(recorder, { phase: "acceptInput", acquire: async () => input });
    try {
      expect(input.actor.target.database.kind).toBe("file");
      await expect(
        recorder.stageApproved?.({ runId: "durable-actor", assertCurrent() {} }),
      ).resolves.toBe(true);
      expect(
        readSessionPendingInputByKey(f.database, f.scope, message.idempotencyKey),
      ).toMatchObject({
        state: "queued",
        consumed_event_id: null,
      });
      expect(f.events()).toEqual([]);
      bindUserTurnInputActor(recorder, { phase: "adoptRun", acquire: async () => input });
      const published = vi.fn<Parameters<typeof withSessionTranscriptSourcePublication>[1]>(() => {
        expect(recorder.hasPersisted()).toBe(true);
        expect(recorder.getPersistedMessage?.()).toEqual(message);
        expect(recorder.getAdmissionReceipt()).toMatchObject({ sessionId: f.scope.sessionId });
        throw failure;
      });
      await expect(
        withSessionTranscriptSourcePublication(f.scope, published, () =>
          recorder.persistApproved(),
        ),
      ).rejects.toThrow(failure.message);
      const identity = readOpenClawAgentDatabaseIdentity(f.database);
      expect(published).toHaveBeenCalledExactlyOnceWith(
        {
          agentId: f.scope.agentId,
          path: f.database.path,
          databaseIdentity: identity.identity,
          databaseBirthtime: identity.birthtime,
        },
        expect.objectContaining({ sessionId: f.scope.sessionId }),
      );
      const receipt = expectDefined(recorder.getAdmissionReceipt(), "committed worker admission");
      expect(recorder.isPendingInputConsumed?.()).toBe(true);
      expect(
        readSessionPendingInputByKey(f.database, f.scope, message.idempotencyKey),
      ).toBeUndefined();
      await expect(recorder.persistFallback()).resolves.toMatchObject({
        appended: true,
        messageId: receipt.entryId,
        message,
      });
      expect(f.events().filter((event) => event.type === "message")).toEqual([
        expect.objectContaining({ id: receipt.entryId, message }),
      ]);
      expect(published).toHaveBeenCalledOnce();
    } finally {
      try {
        recorder.finishPendingInput?.("interrupted");
        await recorder.waitForPendingInputSettlement?.();
      } finally {
        await input.actor.release();
      }
    }
  });
});

it.each(["fresh", "replay"])(
  "fences unstaged original input at COMMIT while retaining %s semantics",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      let live = true;
      const sourceCommitted = vi.fn();
      const assertCurrent = vi.fn(() => {
        if (!live) {
          throw new Error("original input authority closed");
        }
      });
      const recorder = () =>
        createUserTurnTranscriptRecorder({
          message: {
            role: "user",
            content: "synthetic command",
            timestamp: Date.now(),
            idempotencyKey: "unstaged-command",
          },
          target: { ...f.scope, expectedSessionId: f.scope.sessionId, sessionEntry: f.read() },
          assertOriginalInputCommit: assertCurrent,
          beforeMessageWrite: ({ message }) => {
            assertCurrent();
            return message;
          },
          onPersistenceError: () => {},
          updateMode: "none",
        });
      const persist = () =>
        withSessionTranscriptSourcePublication(f.scope, sourceCommitted, () =>
          recorder().persistFallback(),
        );
      if (mode === "replay") {
        await persist();
        expect(sourceCommitted).toHaveBeenCalledOnce();
        sourceCommitted.mockClear();
        live = false;
        assertCurrent.mockClear();
      }
      let commitSeen = false;
      probe.admission(admission, (request, grant, callback) => {
        if (request.stage === "commit") {
          commitSeen = true;
          live = false;
        }
        callback(request, grant);
      });
      if (mode === "fresh") {
        await expect(persist()).rejects.toThrow("original input authority closed");
        expect(commitSeen).toBe(true);
        expect(sourceCommitted).not.toHaveBeenCalled();
        expect(f.events()).toEqual([]);
      } else {
        await expect(persist()).resolves.toMatchObject({ appended: false });
        expect(assertCurrent).not.toHaveBeenCalled();
        expect(sourceCommitted).toHaveBeenCalledOnce();
        expect(f.events().filter((event) => event.type === "message")).toHaveLength(1);
      }
    });
  },
);

it.each(["worker", "native"] as const)(
  "retains a new Goal's committed store through a %s postcommit failure",
  async (writer) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:goal-source-custody",
        sessionId: "goal-source-custody",
        storePath: state.statePath("goal-source.sqlite"),
      };
      const failure = new Error("synthetic postcommit failure");
      const sourceCommitted = vi.fn<Parameters<typeof withSessionTranscriptSourcePublication>[1]>();
      const persistence = expect(
        withSessionTranscriptSourcePublication(scope, sourceCommitted, () =>
          persistSessionTranscriptTurn(scope, {
            expectedSessionId: scope.sessionId,
            initialSessionEntry: { sessionId: scope.sessionId, updatedAt: Date.now() },
            sessionTurnMutation: {
              kind: "goal",
              runId: "goal-source-run",
              operation: {
                action: "start",
                objective: "Retain this committed Goal.",
                operationId: "goal-source-operation",
                requestFingerprint: "goal-source-fingerprint",
                issuedAtMs: Date.now(),
              },
            },
            messages: [
              {
                eventId: "goal-source-message",
                message: { role: "user", content: "Retain this committed Goal." },
                ...(writer === "native"
                  ? {
                      beforeFreshMessageCommit() {
                        const database = openOpenClawAgentDatabase({
                          agentId: scope.agentId,
                          path: scope.storePath,
                        });
                        expect(
                          deferSqlitePostCommitPublication(database.db, () => {
                            throw failure;
                          }),
                        ).toBe(true);
                      },
                    }
                  : {}),
              },
            ],
            ...(writer === "worker"
              ? {
                  onMessageCommitted() {
                    throw failure;
                  },
                }
              : {}),
          }),
        ),
      );
      if (writer === "worker") {
        await persistence.rejects.toBe(failure);
      } else {
        await persistence.resolves.toMatchObject({ appendedCount: 1 });
      }
      const database = openOpenClawAgentDatabase({
        agentId: scope.agentId,
        path: scope.storePath,
      });
      const identity = readOpenClawAgentDatabaseIdentity(database);
      expect(sourceCommitted).toHaveBeenCalledExactlyOnceWith(
        {
          agentId: database.agentId,
          path: database.path,
          databaseIdentity: identity.identity,
          databaseBirthtime: identity.birthtime,
        },
        expect.objectContaining({
          sessionId: scope.sessionId,
          goal: expect.objectContaining({ objective: "Retain this committed Goal." }),
        }),
      );
      expect(readExactSessionEntryRow(database, scope.sessionKey)?.entry.goal?.objective).toBe(
        "Retain this committed Goal.",
      );
      expect(
        readTranscriptEventRows(database, scope.sessionId).filter(
          (row) => JSON.parse(row.eventJson).id === "goal-source-message",
        ),
      ).toHaveLength(1);
    });
  },
);

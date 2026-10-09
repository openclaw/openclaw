import { afterEach, expect, it, vi } from "vitest";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";
import { createSessionCompoundWorkerFixture as fixture } from "./session-compound-worker.test-support.js";
import { withSessionTranscriptSourcePublication } from "./transcript-write-context.js";

afterEach(() => {
  vi.restoreAllMocks();
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
      const create = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          create((request, grant) => {
            if (request.stage === "commit") {
              commitSeen = true;
              live = false;
            }
            callback(request, grant);
          }, attachment),
      );
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
  "records a new Goal's committed store before a %s postcommit failure",
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
      await expect(
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
      ).rejects.toBe(failure);
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

import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import {
  beginSessionEffect,
  bindSessionControllerTarget,
  captureSessionTarget,
  isSessionControllerWorkActive,
  isSessionMutationActive,
} from "../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import {
  seedSessionEntry,
  seedTranscriptRows,
} from "./server.sessions.compaction-fixtures.test-support.js";
import { embeddedRunMock } from "./test-helpers.js";
import { createCompactionResult } from "./test-helpers.runtime-state.js";
import {
  directSessionReq,
  expectNoSessionQueueCleanup,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

afterEach(() => vi.useRealTimers());
const compactedResult = createCompactionResult();

async function createCompactionSession(sessionId: string) {
  const sessionKey = "agent:main:main";
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({ entry: sessionStoreEntry(sessionId), sessionKey, storePath });
  await seedTranscriptRows({ sessionId, sessionKey, storePath, totalLines: 3 });
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    aliases: ["main", sessionId],
    incarnation: sessionId,
    agentId: "main",
  });
  return { storePath, sessionId, sessionKey, target };
}

test.each([true, false])(
  "sessions.compact respects controller run abortability: %s",
  async (abortable) => {
    const { storePath, sessionId, sessionKey, target } = await createCompactionSession(
      "sess-compact-queued-work",
    );
    embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce(compactedResult);
    const started = createDeferred();
    const stopped = createDeferred();
    let interrupted = false;
    const activeRun = withSessionTurn(
      { sessionKey, sessionId, target },
      async (operation, signal) => {
        assert.ok(operation);
        operation.attachBackend({
          kind: "embedded",
          cancel: () => {},
          isAbortable: () => abortable,
        });
        const effect = await beginSessionEffect({
          target,
          assertAllowed: () => {},
          onInterrupt: () => {
            interrupted = true;
          },
        });
        try {
          started.resolve();
          signal.addEventListener("abort", () => {
            interrupted = true;
            stopped.resolve();
          });
          await stopped.promise;
        } finally {
          effect.release();
        }
      },
    );
    await started.promise;

    try {
      const compacted = await directSessionReq("sessions.compact", { key: "main" });
      expect(interrupted).toBe(abortable);
      if (abortable) {
        expect(compacted.ok).toBe(true);
        await activeRun;
      } else {
        expect(compacted).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", message: expect.stringContaining("has an active run") },
        });
      }
      expect(isSessionControllerWorkActive(storePath, [sessionId])).toBe(!abortable);
      expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(Number(abortable));
      expectNoSessionQueueCleanup();
    } finally {
      stopped.resolve();
      await activeRun;
    }
  },
);

test("sessions.compact preserves its active-run error when controller preemption times out", async () => {
  const { sessionId, sessionKey, storePath, target } =
    await createCompactionSession("sess-compact-timeout");
  const operation = createReplyOperation({
    sessionKey,
    sessionId,
    target,
    resetTriggered: false,
  });
  bindSessionControllerTarget(operation, target);
  const preemptAttempted = createDeferred();
  vi.spyOn(operation, "abort").mockImplementation(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    preemptAttempted.resolve();
    return false;
  });
  const compaction = directSessionReq("sessions.compact", { key: "main" });
  void compaction.catch(() => {});
  try {
    await awaitGateBeforeSettlement(
      preemptAttempted.promise,
      compaction,
      "Compaction returned without attempting controller preemption",
    );
    expect(isSessionMutationActive(storePath, target.aliases)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();

    expect(await compaction).toEqual({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Session main has an active run; retry after it finishes.",
      },
    });
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
  } finally {
    operation.complete();
    await compaction.catch(() => undefined);
  }
});

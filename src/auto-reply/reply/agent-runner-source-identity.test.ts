import { expect, it } from "vitest";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeliverySuite } from "./agent-runner-delivery-suite.test-support.js";
import { createReplyActorFixture } from "./reply-actor.test-support.js";
import { createReplyInputAdmission } from "./reply-input-admission.js";

const { createFixture } = createDeliverySuite();

it("binds the admitted source identity for ordinary steering", async () => {
  const fixture = await createFixture();
  const { storePath, replyOperation: operation, followupRun } = fixture.context;
  const sessionKey = fixture.context.sessionKey!;
  await fixture.replace({ sessionId: fixture.sessionId, updatedAt: 1 });
  await using actor = createReplyActorFixture({
    agentId: "main",
    storePath,
    sessionKey,
    getSessionId: () => operation.sessionId,
    operation,
  });
  await actor.bind();
  operation.attachBackend({
    kind: "embedded",
    runId: "backend-run",
    cancel: () => {},
    messageInjection: { isAvailable: () => true, queueMessage: async () => {} },
  });
  const input = createReplyInputAdmission({
    followupRun,
    replyOperation: operation,
    runId: "backend-run",
    sourceTurnId: "current-source",
    sessionKey,
    storePath,
    setEntry: () => {},
  });
  await input.admitUserTurn();
  expect(captureCurrentReplyMessageInjectionTarget(sessionKey)).toMatchObject({
    sourceTurnId: "current-source",
  });
});

it("transfers queued input into durable running custody before source adoption", async () => {
  const fixture = await createFixture();
  const { storePath, replyOperation, followupRun, runId } = fixture.context;
  const sessionKey = fixture.context.sessionKey!;
  const target = { agentId: "main", sessionId: fixture.sessionId, sessionKey, storePath };
  await fixture.replace({ sessionId: fixture.sessionId, updatedAt: 1, status: "done" });
  const recorder = createUserTurnTranscriptRecorder({
    input: { text: "Queued input must survive adoption", idempotencyKey: `${runId}:user` },
    target: { ...target, sessionEntry: { sessionId: fixture.sessionId, updatedAt: 1 } },
  });
  followupRun.userTurnTranscriptRecorder = recorder;
  await recorder.stageApproved!({ runId, assertCurrent() {} });
  expect((await listSessionPendingInputs(target)).items).toHaveLength(1);
  await using actor = createReplyActorFixture({
    ...target,
    getSessionId: () => fixture.sessionId,
    operation: replyOperation,
  });
  await actor.bind();
  const input = createReplyInputAdmission({
    followupRun,
    replyOperation,
    runId,
    sessionKey,
    storePath,
    sourceTurnId: `${runId}:user`,
    setEntry() {},
  });
  try {
    await input.admitUserTurn(recorder);
    // No runtime start or adoption callback has run. The append transaction
    // must already own recovery once it has consumed the queued row.
    expect((await listSessionPendingInputs(target)).items).toEqual([]);
    const entry = loadSessionEntry(target);
    expect(entry).toMatchObject({ lifecycleRunId: runId, abortedLastRun: false });
    expect(entry?.status).toBeUndefined();
    expect(entry?.startedAt).toBeGreaterThanOrEqual(replyOperation.startedAtMs);
    expect(await loadTranscriptEvents(target)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            role: "user",
            content: "Queued input must survive adoption",
          }),
        }),
      ]),
    );
  } finally {
    recorder.finishPendingInput?.("interrupted", "failed");
    await recorder.waitForPendingInputSettlement?.();
  }
});

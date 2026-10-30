import { expect, it } from "vitest";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
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

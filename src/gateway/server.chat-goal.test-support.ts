import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { loadSessionEntry, loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import * as sessionIdentity from "../config/sessions/session-accessor.sqlite-identity.js";
import type { RespondFn } from "./server-methods/types.js";
import { prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

type GoalChatScope = { agentId: string; sessionKey: string; sessionId: string; storePath: string };

export function createGoalChatStartRequest(
  scope: Pick<GoalChatScope, "sessionKey" | "sessionId">,
  message: string,
  idempotencyKey: string,
) {
  return {
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    message,
    idempotencyKey,
    intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
  };
}

export function readGoalChatUserMessages(scope: GoalChatScope) {
  const transcriptScope = {
    ...scope,
    sessionId: loadSessionEntry(scope)?.sessionId ?? scope.sessionId,
  };
  return loadTranscriptEventsSync(transcriptScope).flatMap((event) => {
    if (!event || typeof event !== "object" || !("message" in event)) {
      return [];
    }
    const message = event.message;
    return message && typeof message === "object" && "role" in message && message.role === "user"
      ? [message]
      : [];
  });
}

export function registerGoalChatRestartSettlementCase(fixture: {
  scope: () => GoalChatScope;
  createStorePath: () => string;
  send: (params: Record<string, unknown>) => Promise<Mock<RespondFn>>;
  assertNoModelRun: () => void;
}) {
  it("records a first Goal's retryable failure in its new store when input publication throws after commit", async () => {
    await releaseGatewaySessionStoreFixture(path.dirname(fixture.scope().storePath));
    const storePath = fixture.createStorePath();
    await prepareGatewayReplyRuntimeForTest({ force: true });
    expect(existsSync(storePath)).toBe(false);
    const { sessionId: _sessionId, ...request } = createGoalChatStartRequest(
      fixture.scope(),
      "Keep the committed Goal after publication fails",
      "goal-publication-failure",
    );
    const publish = sessionIdentity.publishCommittedSessionIdentity;
    let rejected = false;
    const notification = vi
      .spyOn(sessionIdentity, "publishCommittedSessionIdentity")
      .mockImplementation((...args) => {
        publish(...args);
        if (!rejected && args[3].has(request.sessionKey)) {
          rejected = true;
          throw new Error("Synthetic input publication failed after commit");
        }
      });
    try {
      const response = await fixture.send(request);
      expect(rejected).toBe(true);
      expect(response.mock.calls[0]?.[0]).toBe(false);
      fixture.assertNoModelRun();
      expect(loadSessionEntry(fixture.scope())).toMatchObject({
        status: "failed",
        lastRunId: request.idempotencyKey,
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: request.idempotencyKey,
        goal: { objective: request.message },
      });
      expect(readGoalChatUserMessages(fixture.scope())).toHaveLength(1);
    } finally {
      notification.mockRestore();
    }
  });
}

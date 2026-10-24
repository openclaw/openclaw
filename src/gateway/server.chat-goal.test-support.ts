import { existsSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi, type Mock } from "vitest";
import { loadSessionEntry, loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import * as sessionIdentity from "../config/sessions/session-accessor.sqlite-identity.js";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { RespondFn } from "./server-methods/types.js";
import { prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
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
  return loadTranscriptEventsSync({
    ...scope,
    sessionId: loadSessionEntry(scope)?.sessionId ?? scope.sessionId,
  }).flatMap((event) => {
    if (!isRecord(event) || !isRecord(event.message)) {
      return [];
    }
    return event.message.role === "user" ? [event.message] : [];
  });
}

export function expectGoalChatRetryResponses(
  responses: readonly Mock<RespondFn>[],
  runId: string,
  goalId: string | undefined,
) {
  let started = false;
  for (const response of responses) {
    const [ok, result, error] = response.mock.calls[0]!;
    if (ok) {
      started ||= isRecord(result) && result.status === "started";
      if (isRecord(result) && result.status === "in_flight") {
        expect(result).toEqual({ status: "in_flight", runId });
      } else {
        expect(result).toMatchObject({ status: "started", goalId });
      }
    } else {
      expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    }
  }
  expect(started).toBe(true);
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
      expect(rejected, `Publication calls: ${notification.mock.calls.length}`).toBe(true);
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

export function installReplyDispatchHook(eligibleDispatchKinds?: readonly ["acp"]) {
  const handler = vi.fn(async () => ({
    handled: true,
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  }));
  const registry = getTestPluginRegistry();
  registry.typedHooks.push({
    pluginId: "goal-dispatch-fixture",
    hookName: "reply_dispatch",
    handler,
    ...(eligibleDispatchKinds ? { eligibleDispatchKinds } : {}),
    source: "test",
  });
  initializeGlobalHookRunner(registry);
  return handler;
}

export function registerGoalChatOperationCollisionCases(fixture: {
  scope: () => GoalChatScope;
  goalStart: (
    message: string,
    idempotencyKey: string,
  ) => ReturnType<typeof createGoalChatStartRequest>;
  rpc: (method: "chat.send", params: Record<string, unknown>) => Promise<Mock<RespondFn>>;
  withHeldModel: (run: () => Promise<void>) => Promise<void>;
  userMessages: () => ReturnType<typeof readGoalChatUserMessages>;
  waitForModelRun: () => Promise<void>;
}) {
  it.each(["objective", "issuedAtMs"] as const)(
    "rejects a concurrent operation ID collision on %s",
    async (collision) => {
      const firstRequest = fixture.goalStart(
        "Finish the release checklist",
        `goal-collision-${collision}`,
      );
      const secondRequest = {
        ...firstRequest,
        ...(collision === "objective"
          ? { message: "Review the migration plan" }
          : { intent: { ...firstRequest.intent, issuedAtMs: firstRequest.intent.issuedAtMs + 1 } }),
      };
      await fixture.withHeldModel(async () => {
        const responses = await Promise.all([
          fixture.rpc("chat.send", firstRequest),
          fixture.rpc("chat.send", secondRequest),
        ]);
        const accepted = responses.flatMap((response, index) =>
          response.mock.calls[0]?.[0] ? [index] : [],
        );
        expect(accepted).toHaveLength(1);
        const rejected = responses[accepted[0] === 0 ? 1 : 0];
        expect(rejected?.mock.calls[0]).toEqual([
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            details: expect.objectContaining({ reason: "goal-operation-conflict" }),
          }),
        ]);
        const acceptedRequest = [firstRequest, secondRequest][accepted[0]!];
        expect(loadSessionEntry(fixture.scope())?.goal?.objective).toBe(acceptedRequest?.message);
        expect(fixture.userMessages()).toEqual([
          expect.objectContaining({ content: acceptedRequest?.message }),
        ]);
        await fixture.waitForModelRun();
      });
    },
  );
}

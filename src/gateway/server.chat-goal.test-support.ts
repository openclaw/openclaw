import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi, type Mock, type MockInstance } from "vitest";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { createCreateGoalTool } from "../agents/tools/goal-tools.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as sessionIdentity from "../config/sessions/session-accessor.sqlite-identity.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { RespondFn } from "./server-methods/types.js";
import { prepareGatewayReplyRuntimeForTest, writeSessionStore } from "./test-helpers.js";
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
        goal: { objective: request.message },
      });
      expect(readGoalChatUserMessages(fixture.scope())).toHaveLength(1);
    } finally {
      notification.mockRestore();
    }
  });
}

export function createGoalChatRunGate(throws: boolean) {
  const hook = vi.fn(async () => {
    if (throws) {
      throw new Error("Synthetic policy failure");
    }
    return { outcome: "block" as const, reason: "policy", message: "Request blocked." };
  });
  const registration = {
    pluginId: "goal-worker-policy",
    hookName: "before_agent_run" as const,
    handler: hook,
    source: "test",
  };
  const registry = getTestPluginRegistry();
  return {
    hook,
    installHook() {
      registry.typedHooks.push(registration);
      initializeGlobalHookRunner(registry);
    },
    removeHook() {
      registry.typedHooks = registry.typedHooks.filter((entry) => entry !== registration);
      initializeGlobalHookRunner(registry);
    },
  };
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

export function goalAgentResult(sessionId: string, text: string) {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 0,
      agentMeta: {
        sessionId,
        provider: "test",
        model: "test",
        usage: { input: 1, output: 1 },
      },
    },
  };
}

export function registerGoalChatSpawnCases(fixture: {
  scope: () => GoalChatScope;
  setSessionKey: (key: string) => void;
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>;
  rpc: (
    method: "chat.send" | "sessions.goal.update",
    params: Record<string, unknown>,
  ) => Promise<Mock<RespondFn>>;
}) {
  const { scope, runEmbeddedAgent, rpc } = fixture;
  const userMessages = () => readGoalChatUserMessages(scope());
  const expectDrained = async () =>
    expect((await waitForGatewayActiveWork(30_000)).drained).toBe(true);
  it("resumes an agent-created Goal in a visible spawned task without losing its lineage", async () => {
    const sessionKey = "agent:main:dashboard:spawned-goal-task";
    fixture.setSessionKey(sessionKey);
    const { sessionId } = scope();
    const lineage = {
      createdVia: "spawn" as const,
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
    };
    await writeSessionStore({
      entries: { [sessionKey]: { sessionId, updatedAt: Date.now(), ...lineage } },
    });
    const objective = "Finish the memory regression investigation";
    runEmbeddedAgent.mockImplementationOnce(async (params) => {
      await createCreateGoalTool({
        agentSessionKey: sessionKey,
        runId: params.runId,
        config: getRuntimeConfig(),
      }).execute("create-task-goal", { objective });
      await patchSessionEntryCore(scope(), (entry) => ({
        goal: entry.goal && { ...entry.goal, status: "paused" },
      }));
      return goalAgentResult(params.sessionId, "Investigation paused.");
    });
    const started = await rpc("chat.send", {
      sessionKey,
      sessionId,
      message: objective,
      idempotencyKey: randomUUID(),
    });
    expect(started.mock.calls[0]?.[0]).toBe(true);
    await expectDrained();
    const goal = loadSessionEntry(scope())?.goal;
    expect(goal).toMatchObject({ objective, status: "paused" });
    const request = {
      sessionKey,
      sessionId,
      goalId: goal?.id,
      action: "resume",
      operationId: randomUUID(),
      issuedAtMs: Date.now(),
    };
    runEmbeddedAgent.mockImplementationOnce(async (params) => {
      expect(loadSessionEntry(scope())?.goal).toMatchObject({ id: goal?.id, status: "active" });
      await patchSessionEntryCore(scope(), (entry) => ({
        goal: entry.goal && { ...entry.goal, status: "complete", completedAt: Date.now() },
      }));
      return goalAgentResult(params.sessionId, "Investigation complete.");
    });
    const resumed = await rpc("sessions.goal.update", request);
    expect(resumed.mock.calls[0]?.[2]).toBeUndefined();
    expect(resumed.mock.calls[0]?.[1]).toMatchObject({
      status: "started",
      runId: request.operationId,
      goalId: goal?.id,
    });
    await expectDrained();
    expect(loadSessionEntry(scope())).toMatchObject({
      ...lineage,
      goal: { id: goal?.id, createdAt: goal?.createdAt, objective, status: "complete" },
    });
    const replay = await rpc("sessions.goal.update", request);
    expect(replay.mock.calls[0]?.[1]).toMatchObject({ replayed: true, runId: request.operationId });
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(userMessages()).toHaveLength(2);
  });

  it.each([
    { key: "agent:main:subagent:hidden-goal", entry: { createdVia: "spawn" } },
    { key: "agent:main:dashboard:leaf-goal", entry: { createdVia: "spawn", subagentRole: "leaf" } },
    { key: "agent:main:dashboard:unclassified-child", entry: { createdVia: "operator" } },
  ] as const)("rejects direct Goal input in $key", async ({ key, entry }) => {
    const { sessionId } = scope();
    const sessionKey = key;
    fixture.setSessionKey(sessionKey);
    await writeSessionStore({
      entries: {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
          spawnDepth: 1,
          ...entry,
        },
      },
    });
    const response = await rpc(
      "chat.send",
      createGoalChatStartRequest(scope(), "Do not start an unsupported Goal", randomUUID()),
    );
    expect(response.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "goal-invalid" },
    });
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(userMessages()).toEqual([]);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });
}

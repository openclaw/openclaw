// Registered at their original suite positions to retain hook and shared-state ordering.
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../session-utils.types.js";
import {
  buildExistingMainStoreEntry,
  expectRecordFields,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  mockCallArg,
  mockMainSessionEntry,
  waitForAssertion,
} from "./agent.test-harness.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";

const mocks = getAgentTestMocks();

export function registerAgentSendEventTests(): void {
  it("reactivates completed subagent sessions and broadcasts send updates", async () => {
    const childSessionKey = "agent:main:subagent:followup";
    const updatedAt = Date.now() - 1_000;
    const completedRun = {
      runId: "run-old",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep" as const,
      createdAt: 1,
      execution: {
        status: "terminal" as const,
        startedAt: 2,
        endedAt: 3,
        outcome: { status: "ok" as const },
      },
    };

    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "sess-followup",
        updatedAt,
      },
      canonicalKey: childSessionKey,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        [childSessionKey]: {
          sessionId: "sess-followup",
          updatedAt,
        },
      };
      return await updater(store);
    });
    mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(completedRun);
    mocks.replaceSubagentRunAfterSteer.mockReturnValueOnce(true);
    const sessionRow = {
      key: childSessionKey,
      kind: "direct",
      updatedAt,
      sessionId: "sess-followup",
      status: "running",
      startedAt: 123,
      endedAt: undefined,
      runtimeMs: 10,
    } satisfies GatewaySessionRow;
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    const broadcastToConnIds = vi.fn();
    await invokeAgent(
      {
        message: "follow-up",
        sessionKey: childSessionKey,
        idempotencyKey: "run-new",
      },
      {
        respond,
        context: {
          ...makeContext({ agentId: "main", row: sessionRow }),
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        },
      },
    );

    expect(mockCallArg(respond)).toBe(true);
    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId: "run-new",
      status: "accepted",
    });
    expect(mockCallArg(respond, 0, 2)).toBeUndefined();
    expect(mockCallArg(respond, 0, 3)).toEqual({ runId: "run-new" });
    expectSubagentFollowupReactivation({
      replaceSubagentRunAfterSteerMock: mocks.replaceSubagentRunAfterSteer,
      broadcastToConnIds,
      completedRun,
      childSessionKey,
      status: "running",
      task: "follow-up",
    });
  });

  it("includes live session setting metadata in agent send events", async () => {
    const updatedAt = Date.now() - 1_000;
    mockMainSessionEntry({
      sessionId: "sess-main",
      updatedAt,
      fastMode: true,
      sendPolicy: "deny",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          sessionId: "sess-main",
          updatedAt,
          fastMode: true,
          sendPolicy: "deny",
          lastChannel: "telegram",
          lastTo: "-100123",
          lastAccountId: "acct-1",
          lastThreadId: 42,
        }),
      };
      return await updater(store);
    });
    const sessionRow = {
      key: "agent:main:main",
      kind: "direct",
      updatedAt,
      sessionId: "sess-main",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      fastMode: true,
      sendPolicy: "deny",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
      totalTokens: 12,
      status: "running",
    } satisfies GatewaySessionRow;
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const broadcastToConnIds = vi.fn();
    await invokeAgent(
      {
        message: "test",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-live-settings",
      },
      {
        context: {
          ...makeContext({ agentId: "main", row: sessionRow }),
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        },
      },
    );

    expect(mockCallArg(broadcastToConnIds)).toBe("sessions.changed");
    expectRecordFields(mockCallArg(broadcastToConnIds, 0, 1), {
      sessionKey: "agent:main:main",
      reason: "send",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      fastMode: true,
      sendPolicy: "deny",
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
      totalTokens: 12,
      status: "running",
    });
    expect(mockCallArg(broadcastToConnIds, 0, 2)).toEqual(new Set(["conn-1"]));
    expect(mockCallArg(broadcastToConnIds, 0, 3)).toEqual({
      agentId: "main",
      dropIfSlow: true,
      sessionKeys: ["agent:main:main"],
      prepareSessionProjection: expect.any(Function),
    });
  });
}

export function registerAgentGlobalGoalEventTest(): void {
  it("keeps selected-global goals on agent session change events", async () => {
    const goal = {
      schemaVersion: 1,
      id: "goal-work-global",
      objective: "Finish work global task",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
      tokenStart: 0,
      tokensUsed: 5,
      continuationTurns: 0,
    } satisfies NonNullable<GatewaySessionRow["goal"]>;
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("global");
    mocks.loadSessionEntry.mockReturnValue({
      cfg: { agents: { list: [{ id: "main" }, { id: "work" }] }, session: { scope: "global" } },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    const sessionRow = {
      key: "global",
      sessionId: "global-session-id",
      kind: "global",
      updatedAt: Date.now(),
      goal,
    } satisfies GatewaySessionRow;
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValue(new Promise(() => {}));

    const context = makeContext({ agentId: "work", row: sessionRow });
    context.getSessionEventSubscriberConnIds = () => new Set(["conn-1"]);
    const runId = "idem-agent-global-goal-event";
    await invokeAgent(
      {
        message: "hi",
        agentId: "work",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    await waitForAssertion(() => {
      expect(context.addChatRun).toHaveBeenCalledWith(
        runId,
        expect.objectContaining({ sessionKey: "global", agentId: "work" }),
      );
      expect(context.chatAbortControllers.get(runId)?.agentId).toBe("work");
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({
          sessionKey: "global",
          agentId: "work",
          goal: expect.objectContaining({ id: "goal-work-global" }),
          session: expect.objectContaining({ key: "global", sessionId: "global-session-id", goal }),
        }),
        new Set(["conn-1"]),
        {
          agentId: "work",
          dropIfSlow: true,
          sessionKeys: ["global"],
          prepareSessionProjection: expect.any(Function),
        },
      );
    });
  });
}

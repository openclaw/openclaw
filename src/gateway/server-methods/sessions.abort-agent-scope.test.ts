import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import {
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createWorkerInferenceCancellationService } from "../worker-environments/inference-control.test-helpers.js";
import { workerService } from "./environments.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const chatAbortMock = vi.fn();
const resolveSessionForRunMock = vi.fn();
const abortEmbeddedAgentRunMock = vi.fn();
const clearSessionLifecycleQueuesMock = vi.fn();
const loadSessionEntryMock = vi.fn((sessionKey: string, _opts?: { agentId?: string }) => ({
  canonicalKey: sessionKey,
}));

vi.mock("../server-session-key.js", () => ({
  resolveSessionForRun: (...args: unknown[]) => resolveSessionForRunMock(...args),
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.abort": (...args: unknown[]) => chatAbortMock(...args),
  },
}));

vi.mock("./chat-abort-handler.js", () => ({
  handleChatAbortRequestWithLifecycle: (...args: unknown[]) => chatAbortMock(...args),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadGatewaySessionEntryReadOnlyAsync: (...args: unknown[]) =>
      loadSessionEntryMock(...(args as [string, { agentId?: string }?])),
    loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string; agentId?: string }) =>
      loadSessionEntryMock(params.key, { agentId: params.agentId }),
  };
});

vi.mock("../session-utils-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store.js")>()),
  withGatewaySessionEntry: async (
    sessionKey: string,
    opts: { agentId?: string } | undefined,
    consume: (loaded: ReturnType<typeof loadSessionEntryMock>) => unknown,
  ) => consume(loadSessionEntryMock(sessionKey, opts)),
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/embedded-agent-runner/runs.js")>(
    "../../agents/embedded-agent-runner/runs.js",
  );
  return {
    ...actual,
    abortEmbeddedAgentRun: (sessionId: string) => {
      abortEmbeddedAgentRunMock(sessionId);
      return actual.abortEmbeddedAgentRun(sessionId);
    },
  };
});

vi.mock("../../auto-reply/reply/queue/cleanup.js", async () => {
  const actual = await vi.importActual<typeof import("../../auto-reply/reply/queue/cleanup.js")>(
    "../../auto-reply/reply/queue/cleanup.js",
  );
  return {
    ...actual,
    clearSessionLifecycleQueues: (...args: unknown[]) => clearSessionLifecycleQueuesMock(...args),
  };
});

import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import type { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { callSessions } from "./sessions.abort-agent-scope.request.test-support.js";
import {
  createActiveRun,
  createBetaRunContext,
  createGlobalWorkRunContext,
  createContext,
} from "./sessions.abort-agent-scope.test-support.js";

function expectChatAbortParams(params: Record<string, unknown>): void {
  expect(chatAbortMock).toHaveBeenCalledTimes(1);
  expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ params }));
}

function expectRespondErrorMessage(respond: RespondFn, message: string): void {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ message }));
}

function abortSession(params: Record<string, unknown>, context = createContext()) {
  return callSessions("sessions.abort", params, { context });
}

function mockSessionEntry(sessionId: string, key?: string): void {
  loadSessionEntryMock.mockImplementationOnce((sessionKey: string) => ({
    canonicalKey: key ?? sessionKey,
    entry: { sessionId },
  }));
}

function expectAbortResult(respond: RespondFn, status: "aborted" | "no-active-run"): void {
  expect(respond).toHaveBeenCalledWith(
    true,
    { ok: true, abortedRunId: null, status },
    undefined,
    undefined,
  );
}

function expectSessionChange(
  broadcast: ReturnType<typeof vi.fn>,
  details: Record<string, unknown>,
  agentId: string,
  options: Record<string, unknown> = {},
): void {
  expect(broadcast).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({ reason: "abort", ...details }),
    new Set(["conn-1"]),
    { agentId, dropIfSlow: true, ...options },
  );
}

async function expectMutationErrors(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  message: string,
): Promise<void> {
  for (const method of ["sessions.patch", "sessions.delete", "sessions.compact"] as const) {
    const respond = await callSessions(
      method,
      {
        ...params,
        ...(method === "sessions.patch" ? { label: "Changed" } : {}),
      },
      { context },
    );
    expectRespondErrorMessage(respond, message);
  }
}

function mockChatSuccess(runIds: string[] = []): void {
  const payload = { ok: true, aborted: runIds.length > 0, runIds };
  chatAbortMock.mockImplementationOnce(
    async (...[options, lifecycle]: Parameters<typeof handleChatAbortRequestWithLifecycle>) => {
      if (!lifecycle?.onAuthorizedBeforeEmbeddedAbort) {
        options.respond(true, payload);
        return;
      }
      // Session cleanup now consumes the real shared plan's embedded Stop outcome.
      const agentId = options.params.agentId;
      if (typeof agentId !== "string") {
        throw new Error("Missing selected abort agent");
      }
      const cfg = options.context.getRuntimeConfig();
      const capturedSession = {
        ...loadSessionEntryMock.mock.results.at(-1)?.value,
        cfg,
        agentId,
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
      };
      loadSessionEntryMock.mockReturnValueOnce(capturedSession);
      const actual =
        await vi.importActual<typeof import("./chat-abort-handler.js")>("./chat-abort-handler.js");
      Object.assign(options.context, {
        ...createDirectChatContext({ getRuntimeConfig: options.context.getRuntimeConfig }),
        ...options.context,
      });
      await actual.handleChatAbortRequestWithLifecycle(options, lifecycle);
    },
  );
}

const projections = new Set<ReturnType<typeof createSessionRowProjectionFixture>>();

function projectSession(
  context: GatewayRequestContext,
  key: string,
  agentId: string,
  sessionId: string,
): void {
  const projection = createSessionRowProjectionFixture({
    cfg: context.getRuntimeConfig(),
    agentId,
    storePath: "/tmp/openclaw-sessions.json",
    store: { [key]: { sessionId, updatedAt: 1 } },
  });
  projections.add(projection);
  bindSessionRowProjection(context, () => projection);
}

vi.mock("../call.js", () => ({
  callGateway: async (request: { method: string }) => {
    expect(request.method).toBe("agent.wait");
    return { status: "pending" };
  },
}));

describe("sessions.abort agent scope", () => {
  afterEach(async () => {
    for (const projection of projections) {
      projection.dispose();
    }
    projections.clear();
    await resetSubagentRegistryForTests({ persist: false });
  });

  beforeEach(() => {
    chatAbortMock.mockReset();
    resolveSessionForRunMock.mockReset();
    loadSessionEntryMock.mockReset();
    abortEmbeddedAgentRunMock.mockReset();
    clearSessionLifecycleQueuesMock.mockReset();
    clearSessionLifecycleQueuesMock.mockReturnValue({
      followupCleared: 0,
      laneCleared: 0,
      keys: [],
    });
  });

  it("does not abort an active run whose session key belongs to another requested agent", async () => {
    const activeRun = createActiveRun("agent:beta:dashboard:target");
    const context = createBetaRunContext(activeRun);
    const respond = await abortSession({ runId: "run-beta", agentId: "main" }, context);

    expect(resolveSessionForRunMock).toHaveBeenCalledWith("run-beta", { agentId: "main" });
    expect(chatAbortMock).not.toHaveBeenCalled();
    expect(activeRun.controller.signal.aborted).toBe(false);
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      abortedRunId: null,
      status: "no-active-run",
    });
  });

  it("rejects an embedded run ID owned by another session", async () => {
    const ownerKey = "agent:main:telegram:direct:owner";
    const requestedKey = "agent:main:telegram:direct:other";
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "run-embedded", abort });
    setActiveEmbeddedRun("session-owner", handle, ownerKey);
    mockSessionEntry("session-other", requestedKey);
    try {
      const respond = await abortSession({ key: requestedKey, runId: "run-embedded" });

      expect(abort).not.toHaveBeenCalled();
      expectRespondErrorMessage(respond, "runId does not match session");
    } finally {
      clearActiveEmbeddedRun("session-owner", handle, ownerKey);
    }
  });

  it("marks a listed session active when the embedded registry owns its session id", async () => {
    const context = createContext({
      extra: { loadGatewayModelCatalog: vi.fn().mockResolvedValue([]) },
    });
    const sessionKey = "agent:main:openclaw-weixin:direct:user";
    const handle = createEmbeddedRunHandle({ runId: "run-channel-active" });
    setActiveEmbeddedRun("sess-weixin", handle, sessionKey, undefined, "main");
    onTestFinished(() => clearActiveEmbeddedRun("sess-weixin", handle, sessionKey));
    projectSession(context, sessionKey, "main", "sess-weixin");

    const respond = await callSessions(
      "sessions.list",
      { agentId: "main" },
      { context, reqId: "req-channel-active" },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessions: [
          expect.objectContaining({
            key: "agent:main:openclaw-weixin:direct:user",
            sessionId: "sess-weixin",
            hasActiveRun: true,
          }),
        ],
      }),
    );
  });

  it("preserves runId-only aborts for active non-default agent runs", async () => {
    const activeRun = createActiveRun("agent:beta:dashboard:target");
    const context = createBetaRunContext(activeRun);

    await abortSession({ runId: "run-beta" }, context);

    expect(resolveSessionForRunMock).not.toHaveBeenCalled();
    expectChatAbortParams({
      sessionKey: "agent:beta:dashboard:target",
      runId: "run-beta",
      agentId: "beta",
    });
  });

  it("kills controlled subagents after the parent run has already ended", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot(createContext().getRuntimeConfig());
      try {
        const actualChatAbort =
          await vi.importActual<typeof import("./chat-abort-handler.js")>(
            "./chat-abort-handler.js",
          );
        chatAbortMock.mockImplementationOnce(actualChatAbort.handleChatAbortRequestWithLifecycle);
        const childSessionKey = "agent:main:subagent:orphaned-after-parent-stop";
        replaceSessionEntrySync(
          {
            sessionKey: childSessionKey,
            storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          },
          {
            sessionId: "session-orphaned-child",
            updatedAt: Date.now(),
            spawnedBy: "agent:main:main",
            parentSessionKey: "agent:main:main",
          },
        );
        await registerSubagentRun({
          runId: "run-orphaned-child",
          childSessionKey,
          childAgentId: "main",
          sessionEntry: loadSessionEntry({ agentId: "main", sessionKey: childSessionKey }),
          controllerSessionKey: "agent:main:main",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          requesterAgentId: "main",
          requesterTurnRunId: "ended-parent-run",
          task: "orphaned child",
          cleanup: "keep",
        });
        const context = createContext({
          extra: {
            agentRunSeq: new Map(),
            broadcast: vi.fn(),
            cancelRunBoundApprovals: vi.fn(),
            chatQueuedTurns: new Map(),
            chatRunState: { resolveBuffer: () => ({ text: "" }) } as never,
            dedupe: new Map(),
            getSessionEventSubscriberConnIds: () => new Set(),
            nodeSendToSession: vi.fn(),
            removeChatRun: vi.fn(),
          },
        });

        loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
          cfg: context.getRuntimeConfig(),
          canonicalKey: sessionKey,
        }));

        const respond = await abortSession({ key: "agent:main:main" }, context);

        expectAbortResult(respond, "aborted");
        expect(await getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
          endedReason: "subagent-killed",
          killReconciliation: { suppressTaskDelivery: true },
        });
      } finally {
        await resetSubagentRegistryForTests({ persist: false });
      }
    });
  });

  it("resolves runId-only worker aborts to the owning session", async () => {
    mockChatSuccess(["run-worker"]);
    const context = createContext({
      extra: {
        workerEnvironmentService: Object.assign(
          createWorkerInferenceCancellationService("session-worker", ["run-worker"], () => [], {
            agentId: "work",
            sessionId: "session-worker",
            sessionKey: "agent:work:dashboard:worker",
            storePath: "/original-worker-store/sessions.json",
          }),
          workerService(),
          {
            startTunnel: async () => {
              throw new Error("unexpected tunnel in cancellation fixture");
            },
            stopTunnel: async () => {},
          },
        ),
        dedupe: new Map(),
        getSessionEventSubscriberConnIds: () => new Set(),
      },
    });

    await abortSession({ runId: "run-worker" }, context);

    expectChatAbortParams({
      sessionKey: "agent:work:dashboard:worker",
      runId: "run-worker",
      agentId: "work",
    });
    expect(context.dedupe?.size).toBe(0);
  });

  it("emits selected global abort changes with agent scope", async () => {
    const activeRun = createActiveRun("global", { agentId: "work" });
    const broadcastToConnIds = vi.fn();
    chatAbortMock.mockImplementationOnce(
      async ({ respond: abortRespond }: { respond: RespondFn }) => {
        abortRespond(true, { ok: true, aborted: true, runIds: ["run-global"] });
      },
    );
    const context = {
      ...createGlobalWorkRunContext(activeRun),
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      broadcastToConnIds,
      dedupe: new Map(),
    };

    await abortSession({ key: "global", runId: "run-global" }, context);

    expect(resolveSessionForRunMock).not.toHaveBeenCalled();
    expectChatAbortParams({ sessionKey: "global", runId: "run-global", agentId: "work" });
    expectSessionChange(broadcastToConnIds, { sessionKey: "global", agentId: "work" }, "work", {
      sessionEventSubscriptionKeys: ["agent:work:global"],
    });
  });

  it("reports reply-only aborts as aborted without a fabricated run id", async () => {
    const broadcastToConnIds = vi.fn();
    const weixinOperation = createReplyOperation({
      sessionKey: "agent:main:openclaw-weixin:direct:wechat-user",
      sessionId: "weixin-session",
      resetTriggered: false,
    });
    const telegramOperation = createReplyOperation({
      sessionKey: "agent:main:telegram:direct:telegram-user",
      sessionId: "telegram-session",
      resetTriggered: false,
    });
    mockChatSuccess();
    mockSessionEntry("weixin-session");
    const context = createContext({
      extra: {
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        broadcastToConnIds,
        dedupe: new Map(),
      },
    });
    projectSession(
      context,
      "agent:main:openclaw-weixin:direct:wechat-user",
      "main",
      "weixin-session",
    );

    try {
      const respond = await abortSession(
        { key: "agent:main:openclaw-weixin:direct:wechat-user" },
        context,
      );

      expectAbortResult(respond, "aborted");
      expect(clearSessionLifecycleQueuesMock).not.toHaveBeenCalled();
      expect(abortEmbeddedAgentRunMock).toHaveBeenCalledWith("weixin-session");
      expect(weixinOperation.abortSignal.aborted).toBe(true);
      expect(telegramOperation.abortSignal.aborted).toBe(false);
      expectSessionChange(
        broadcastToConnIds,
        { hasActiveRun: false, sessionKey: "agent:main:openclaw-weixin:direct:wechat-user" },
        "main",
        {
          sessionKeys: ["agent:main:openclaw-weixin:direct:wechat-user"],
          sessionEventSubscriptionKeys: ["agent:main:openclaw-weixin:direct:wechat-user"],
          prepareSessionProjection: expect.any(Function),
        },
      );
    } finally {
      weixinOperation.complete();
      telegramOperation.complete();
    }
  });

  it.each([
    { clearQueued: false, globalScope: false },
    { clearQueued: true, globalScope: false },
    { clearQueued: false, globalScope: true },
  ])(
    "applies MCP stop ownership (clearQueued=$clearQueued, global=$globalScope)",
    async ({ clearQueued, globalScope }) => {
      const { getOrCreateSessionMcpRuntime, getSessionMcpRuntimeTestManager, unopenedMcpConfig } =
        await import("../../agents/agent-bundle-mcp-manager.test-support.js");
      const { setSessionMcpRuntimeScheduler } =
        await import("../../agents/agent-bundle-mcp-manager-api.js");
      const scheduler = createTestGatewayScheduler();
      onTestFinished(() => scheduler.stop());
      await setSessionMcpRuntimeScheduler(scheduler);
      const manager = getSessionMcpRuntimeTestManager();
      const sessionKey = globalScope ? "global" : "agent:main:idle-mcp";
      mockChatSuccess();
      mockSessionEntry("idle-mcp", sessionKey);
      try {
        const runtime = await getOrCreateSessionMcpRuntime({
          sessionId: "idle-mcp",
          sessionKey,
          workspaceDir: "/workspace",
          cfg: unopenedMcpConfig,
          manifestRegistry: { plugins: [] },
        });
        await abortSession(
          { key: sessionKey, clearQueued, ...(globalScope ? { agentId: "work" } : {}) },
          createContext({ globalScope }),
        );
        expect(manager.peekSession({ sessionId: "idle-mcp" })).toBe(
          clearQueued || globalScope ? undefined : runtime,
        );
      } finally {
        await manager.disposeAll();
      }
    },
  );

  it("clears key-addressed queues without requiring a persisted session id", async () => {
    const sessionKey = "agent:main:openclaw-weixin:direct:queued-without-entry";
    mockChatSuccess();
    loadSessionEntryMock.mockImplementationOnce(() => ({ canonicalKey: sessionKey }));
    clearSessionLifecycleQueuesMock.mockReturnValueOnce({
      followupCleared: 1,
      laneCleared: 0,
      keys: [sessionKey],
    });
    const context = createContext({
      extra: {
        getSessionEventSubscriberConnIds: () => new Set(),
      },
    });

    const respond = await abortSession({ key: sessionKey, clearQueued: true }, context);

    expect(clearSessionLifecycleQueuesMock).toHaveBeenCalledWith({
      keys: [sessionKey, sessionKey, undefined],
      agentId: "main",
      sessionKey,
      assertCurrent: expect.any(Function),
    });
    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalled();
    expectAbortResult(respond, "aborted");
  });

  it("keeps explicit runId aborts targeted instead of clearing the whole session", async () => {
    mockChatSuccess();
    mockSessionEntry("persisted-session");

    const respond = await abortSession({
      key: "agent:main:openclaw-weixin:direct:wechat-user",
      runId: "missing-run",
    });

    expect(clearSessionLifecycleQueuesMock).not.toHaveBeenCalled();
    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalled();
    expectAbortResult(respond, "no-active-run");
  });

  it.each([true, false])(
    "uses and clears legacy aliases only for their owning agent (owned=%s)",
    async (owned) => {
      mockSessionEntry("work-session");
      mockChatSuccess();
      const context = createContext({
        activeRuns: [["run-work", createActiveRun("main")]],
        ...(owned ? { agents: [{ id: "work", default: true }, { id: "main" }] } : {}),
      });
      await abortSession({ key: "main", agentId: "work", clearQueued: true }, context);
      expectChatAbortParams({
        sessionKey: owned ? "main" : "agent:work:main",
        runId: undefined,
        agentId: "work",
      });
      expect(clearSessionLifecycleQueuesMock).toHaveBeenCalledExactlyOnceWith({
        keys: ["agent:work:main", ...(owned ? ["main"] : []), "agent:work:main", "work-session"],
        agentId: "work",
        sessionKey: "agent:work:main",
        assertCurrent: expect.any(Function),
      });
    },
  );

  it("leaves global-scope cleanup on chat.abort without an agent-qualified queue key", async () => {
    mockChatSuccess();
    mockSessionEntry("work-global-session", "global");
    const context = createContext({ globalScope: true });

    const respond = await abortSession(
      { key: "global", agentId: "work", clearQueued: true },
      context,
    );

    expectChatAbortParams({ sessionKey: "global", runId: undefined, agentId: "work" });
    expect(clearSessionLifecycleQueuesMock).not.toHaveBeenCalled();
    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalled();
    expectAbortResult(respond, "no-active-run");
  });

  it.each([
    {
      name: "selected-agent global session rows active only for their own agent",
      runAgentId: "main",
      agentId: "work",
      hasActiveRun: false,
    },
    {
      name: "unscoped global runs active for the configured default agent",
      runAgentId: undefined,
      agentId: "main",
      hasActiveRun: true,
    },
  ])("marks $name", async ({ runAgentId, agentId, hasActiveRun }) => {
    const context = createContext({
      activeRuns: [["run-global", createActiveRun("global", { agentId: runAgentId })]],
      globalScope: true,
      extra: { loadGatewayModelCatalog: vi.fn().mockResolvedValue([]) },
    });
    projectSession(context, "global", agentId, `sess-${agentId}-global`);
    const respond = await callSessions(
      "sessions.list",
      { includeGlobal: true, agentId },
      { context, reqId: "req-list-global" },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessions: [expect.objectContaining({ key: "global", hasActiveRun })],
      }),
    );
  });

  it.each([
    {
      name: "selected-agent global message events on an agent-scoped key",
      params: { key: "global", agentId: "work" },
      agents: undefined,
    },
    {
      name: "bare global message events on the configured default agent key",
      params: { key: "global" },
      agents: [{ id: "main" }, { id: "work", default: true }],
    },
    {
      name: "selected-agent global message events inferred from agent-prefixed aliases",
      params: { key: "agent:work:main" },
      agents: undefined,
    },
  ])("subscribes $name", async ({ params, agents }) => {
    const subscribeSessionMessageEvents = vi.fn();
    const context = createContext({
      agents,
      globalScope: true,
      extra: { subscribeSessionMessageEvents },
    });
    const respond = await callSessions("sessions.messages.subscribe", params, {
      context,
      reqId: "req-sub-global",
      client: { connId: "conn-sub" } as GatewayClient,
    });

    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(subscribeSessionMessageEvents).toHaveBeenCalledWith("conn-sub", "agent:work:global", {
      provisional: true,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, key: "global", agentId: "work" },
      undefined,
    );
  });

  it("aborts an active legacy-key run owned by the configured default agent", async () => {
    const activeRun = createActiveRun("main");
    const context = createContext({
      activeRuns: [["run-work", activeRun]],
      agents: [{ id: "work" }],
    });

    await abortSession({ runId: "run-work" }, context);

    expect(resolveSessionForRunMock).not.toHaveBeenCalled();
    expectChatAbortParams({ sessionKey: "main", runId: "run-work", agentId: "work" });
  });

  it("rejects key-based aborts when key agent does not match agentId", async () => {
    const context = createContext({
      agents: [{ id: "main", default: true }, { id: "beta" }],
    });
    const respond = await abortSession({ key: "agent:beta:main", agentId: "main" }, context);

    expect(chatAbortMock).not.toHaveBeenCalled();
    expectRespondErrorMessage(respond, "session key agent does not match agentId");
  });

  it("rejects explicit agentId mismatches before session mutations", async () => {
    await expectMutationErrors(
      createContext({ globalScope: true }),
      { key: "agent:main:main", agentId: "work" },
      'agent "work" does not match session key agent "main"',
    );
  });

  it("protects bare global when its fixed-store owner is inferred", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const context = createContext({
        extra: {
          getRuntimeConfig: () => ({
            session: { scope: "global", store: state.statePath("shared.sqlite") },
            agents: {
              ownership: "explicit",
              defaults: { sessionStore: { agentId: "ops" } },
              entries: { ops: {}, research: {} },
            },
          }),
        },
      });
      setRuntimeConfigSnapshot(context.getRuntimeConfig());

      const respond = await callSessions(
        "sessions.delete",
        { key: "global" },
        { context, reqId: "req-persisted-global-delete" },
      );

      expectRespondErrorMessage(respond, "Cannot delete the main session (global).");
      expect(loadSessionEntryMock).not.toHaveBeenCalled();
    });
  });

  it("rejects unknown explicit agentId before session mutations", async () => {
    const context = createContext({ agents: [{ id: "main" }] });
    const respond = await callSessions(
      "sessions.patch",
      { key: "global", agentId: "work", label: "Work" },
      { context, reqId: "req-unknown-agent-patch" },
    );

    expectRespondErrorMessage(respond, 'Unknown agent id "work"');
  });

  it("rejects unknown inferred selected-global aliases before session mutations", async () => {
    await expectMutationErrors(
      createContext({ globalScope: true }),
      { key: "agent:typo:main" },
      'Unknown agent id "typo"',
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import {
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
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
import { fixedStoreOwnershipConfig } from "./sessions-fixed-store.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const chatAbortMock = vi.fn();
const resolveSessionForRunMock = vi.fn();

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
    loadGatewaySessionEntryReadOnly: (...args: unknown[]) =>
      loadScopedSession(...(args as [string, { agentId?: string }?])),
    loadGatewaySessionEntryReadOnlyAsync: async (...args: unknown[]) =>
      loadScopedSession(...(args as [string, { agentId?: string }?])),
    loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string; agentId?: string }) =>
      loadScopedSession(params.key, { agentId: params.agentId }),
  };
});

vi.mock("../session-utils-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store.js")>()),
  withGatewaySessionEntry: async (
    sessionKey: string,
    opts: { agentId?: string } | undefined,
    consume: (loaded: ReturnType<typeof loadScopedSession>) => unknown,
  ) => consume(loadScopedSession(sessionKey, opts)),
}));

import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { callSessions } from "./sessions.abort-agent-scope.request.test-support.js";
import {
  createActiveRun,
  createBetaRunContext,
  createGlobalWorkRunContext,
  createContext,
  fixtureStorePath,
  createQueuedRun,
  createPhysicalOperation,
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "./sessions.abort-agent-scope.test-support.js";

function loadScopedSession(sessionKey: string, opts?: { agentId?: string }) {
  const loaded = loadSessionEntryMock(sessionKey, opts);
  return {
    ...loaded,
    storePath:
      "storePath" in loaded && typeof loaded.storePath === "string"
        ? loaded.storePath
        : fixtureStorePath(opts?.agentId ?? sessionKey.split(":")[1] ?? "main"),
  };
}

function expectChatAbortParams(params: Record<string, unknown>): void {
  expect(chatAbortMock).toHaveBeenCalledTimes(1);
  expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ params }));
}

function expectRespondErrorMessage(respond: RespondFn, message: string): void {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ message }));
}

function mockChatSuccess(payload: Record<string, unknown>): void {
  chatAbortMock.mockImplementationOnce(({ respond }: { respond: RespondFn }) => {
    respond(true, payload);
  });
}

function mockSession(sessionId?: string) {
  loadSessionEntryMock.mockImplementationOnce((canonicalKey: string) => ({
    canonicalKey,
    ...(sessionId ? { entry: { sessionId } } : {}),
  }));
}

function expectAbortResponse(
  respond: RespondFn,
  status = "aborted",
  abortedRunId: string | null = null,
) {
  expect(respond).toHaveBeenCalledWith(
    true,
    { ok: true, abortedRunId, status },
    undefined,
    undefined,
  );
}

function abort(params: Record<string, unknown>, context = createContext()) {
  return callSessions("sessions.abort", params, { context });
}

async function useRealChatAbortHandlerOnce(): Promise<void> {
  const actual =
    await vi.importActual<typeof import("./chat-abort-handler.js")>("./chat-abort-handler.js");
  chatAbortMock.mockImplementationOnce(actual.handleChatAbortRequestWithLifecycle);
}

const projections = new Set<ReturnType<typeof createSessionRowProjectionFixture>>();

function projectSession(
  context: GatewayRequestContext,
  row: {
    key: string;
    agentId: string;
    sessionId: string;
  },
): void {
  const projection = createSessionRowProjectionFixture({
    cfg: context.getRuntimeConfig(),
    agentId: row.agentId,
    storePath: fixtureStorePath(row.agentId),
    store: { [row.key]: { sessionId: row.sessionId, updatedAt: 1 } },
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
  });

  it("does not abort an active run whose session key belongs to another requested agent", async () => {
    const activeRun = createActiveRun("agent:beta:dashboard:target");
    const context = createBetaRunContext(activeRun);
    const respond = await abort({ runId: "run-beta", agentId: "main" }, context);

    expect(resolveSessionForRunMock).toHaveBeenCalledWith("run-beta", { agentId: "main" });
    expect(chatAbortMock).not.toHaveBeenCalled();
    expect(activeRun.input.abortSignal.aborted).toBe(false);
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      abortedRunId: null,
      status: "no-active-run",
    });
  });

  it("rejects an embedded run ID owned by another session", async () => {
    const ownerKey = "agent:main:telegram:direct:owner";
    const requestedKey = "agent:main:telegram:direct:other";
    const abortHandle = vi.fn();
    const handle = createEmbeddedRunHandle({ runId: "run-embedded", abort: abortHandle });
    attachActiveEmbeddedRun("session-owner", handle, ownerKey);
    mockSession("session-other");
    try {
      const respond = await abort({ key: requestedKey, runId: "run-embedded" });
      expect(abortHandle).not.toHaveBeenCalled();
      expectRespondErrorMessage(respond, "runId does not match session");
    } finally {
      detachActiveEmbeddedRun("session-owner", handle, ownerKey);
    }
  });

  it("marks a listed session active when the embedded registry owns its session id", async () => {
    const context = createContext({
      extra: { loadGatewayModelCatalog: vi.fn().mockResolvedValue([]) },
    });
    const sessionKey = "agent:main:openclaw-weixin:direct:user";
    const handle = createEmbeddedRunHandle({ runId: "run-channel-active" });
    attachActiveEmbeddedRun("sess-weixin", handle, sessionKey);
    onTestFinished(() => detachActiveEmbeddedRun("sess-weixin", handle, sessionKey));
    projectSession(context, { key: sessionKey, agentId: "main", sessionId: "sess-weixin" });

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

  it.each([
    {
      key: "agent:beta:dashboard:target",
      agentId: "beta",
      runAgentId: undefined,
      agents: [{ id: "main", default: true }, { id: "beta" }],
    },
    { key: "main", agentId: "work", runAgentId: "work", agents: [{ id: "work" }] },
  ])(
    "preserves runId-only aborts for $key owned by $agentId",
    async ({ key, agentId, runAgentId, agents }) => {
      const context = createContext({
        agents,
        activeRuns: [["run", createActiveRun(key, { agentId: runAgentId })]],
      });
      await abort({ runId: "run" }, context);
      expect(resolveSessionForRunMock).not.toHaveBeenCalled();
      expectChatAbortParams({ sessionKey: key, runId: "run", agentId });
    },
  );

  it("kills controlled subagents after the parent run has already ended", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot(createContext().getRuntimeConfig());
      try {
        await useRealChatAbortHandlerOnce();
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

        const respond = await abort({ key: "agent:main:main" }, context);

        expectAbortResponse(respond);
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
    mockChatSuccess({ ok: true, aborted: true, runIds: ["run-worker"] });
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

    await abort({ runId: "run-worker" }, context);

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
    mockChatSuccess({ ok: true, aborted: true, runIds: ["run-global"] });
    const context = {
      ...createGlobalWorkRunContext(activeRun),
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      broadcastToConnIds,
      dedupe: new Map(),
    };

    await abort({ key: "global", runId: "run-global" }, context);

    expect(resolveSessionForRunMock).not.toHaveBeenCalled();
    expectChatAbortParams({ sessionKey: "global", runId: "run-global", agentId: "work" });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "global",
        agentId: "work",
        reason: "abort",
      }),
      new Set(["conn-1"]),
      {
        agentId: "work",
        dropIfSlow: true,
        sessionEventSubscriptionKeys: ["agent:work:global"],
      },
    );
  });

  it("reports reply-only aborts as aborted without a fabricated run id", async () => {
    const key = "agent:main:openclaw-weixin:direct:wechat-user";
    const broadcastToConnIds = vi.fn();
    const weixinOperation = createPhysicalOperation({
      sessionKey: key,
      sessionId: "weixin-session",
      resetTriggered: false,
    });
    const telegramOperation = createPhysicalOperation({
      sessionKey: "agent:main:telegram:direct:telegram-user",
      sessionId: "telegram-session",
      resetTriggered: false,
    });
    await useRealChatAbortHandlerOnce();
    mockSession("weixin-session");
    const context = createContext({
      extra: {
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        broadcastToConnIds,
        dedupe: new Map(),
      },
    });
    projectSession(context, { key, agentId: "main", sessionId: "weixin-session" });

    try {
      const respond = await abort({ key }, context);
      expectAbortResponse(respond);

      expect(weixinOperation.abortSignal.aborted).toBe(true);
      expect(telegramOperation.abortSignal.aborted).toBe(false);
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({
          hasActiveRun: false,
          sessionKey: key,
          reason: "abort",
        }),
        new Set(["conn-1"]),
        {
          agentId: "main",
          dropIfSlow: true,
          sessionKeys: [key],
          sessionEventSubscriptionKeys: [key],
          prepareSessionProjection: expect.any(Function),
        },
      );
    } finally {
      weixinOperation.complete();
      telegramOperation.complete();
    }
  });

  it.each([true, false])("clears key-addressed queues (persisted=%s)", async (persisted) => {
    const key = "agent:main:openclaw-weixin:direct:queued-user";
    await useRealChatAbortHandlerOnce();
    mockSession(persisted ? "queued-session" : undefined);
    const queued = createQueuedRun(key, "queued-session");
    const context = createContext();
    const respond = await abort({ key, clearQueued: true }, context);
    expect(queued.input.abortSignal.aborted).toBe(true);
    await queued.input.settlement.promise;
    expectAbortResponse(respond);
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
      mockChatSuccess({ ok: true, aborted: false, runIds: [] });
      mockSession("idle-mcp");
      try {
        const runtime = await getOrCreateSessionMcpRuntime({
          sessionId: "idle-mcp",
          sessionKey,
          workspaceDir: "/workspace",
          cfg: unopenedMcpConfig,
          manifestRegistry: { plugins: [] },
        });
        await abort(
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

  it("keeps explicit runId aborts targeted instead of clearing the whole session", async () => {
    mockChatSuccess({ ok: true, aborted: false, runIds: [] });
    mockSession("persisted-session");
    const queued = createQueuedRun(
      "agent:main:openclaw-weixin:direct:wechat-user",
      "persisted-session",
    );
    const context = createContext();

    const respond = await abort(
      { key: "agent:main:openclaw-weixin:direct:wechat-user", runId: "missing-run" },
      context,
    );

    expect(queued.input.abortSignal.aborted).toBe(false);

    expectAbortResponse(respond, "no-active-run");
  });

  it("clears legacy aliases only when they belong to the selected agent", async () => {
    const owned = createQueuedRun("main", "work-session", "work");
    const foreign = createQueuedRun("main", "main-session", "main");
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      canonicalKey: sessionKey,
      agentId: "work",
      entry: { sessionId: "work-session" },
    }));
    await useRealChatAbortHandlerOnce();
    await abort(
      { key: "main", agentId: "work", clearQueued: true },
      createContext({ agents: [{ id: "work", default: true }, { id: "main" }] }),
    );
    expect(owned.input.abortSignal.aborted).toBe(true);
    expect(foreign.input.abortSignal.aborted).toBe(false);
    await owned.input.settlement.promise;
    const selected = createQueuedRun("agent:work:main", "work-session", "work");
    await useRealChatAbortHandlerOnce();
    await abort({ key: "main", agentId: "work", clearQueued: true });
    expect(selected.input.abortSignal.aborted).toBe(true);
    expect(foreign.input.abortSignal.aborted).toBe(false);
  });

  it("leaves global-scope cleanup on chat.abort without an agent-qualified queue key", async () => {
    mockChatSuccess({ ok: true, aborted: false, runIds: [] });
    mockSession("work-global-session");
    const context = createContext({ globalScope: true });

    const respond = await abort({ key: "global", agentId: "work", clearQueued: true }, context);

    expectChatAbortParams({ sessionKey: "global", runId: undefined, agentId: "work" });

    expectAbortResponse(respond, "no-active-run");
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
      activeRuns: [
        [
          "run-global",
          createActiveRun("global", { agentId: runAgentId, sessionId: "sess-main-global" }),
        ],
      ],
      globalScope: true,
      extra: { loadGatewayModelCatalog: vi.fn().mockResolvedValue([]) },
    });
    projectSession(context, { key: "global", agentId, sessionId: `sess-${agentId}-global` });
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

  it("rejects key-based aborts when key agent does not match agentId", async () => {
    const context = createContext({
      agents: [{ id: "main", default: true }, { id: "beta" }],
    });
    const respond = await abort({ key: "agent:beta:main", agentId: "main" }, context);

    expect(chatAbortMock).not.toHaveBeenCalled();
    expectRespondErrorMessage(respond, "session key agent does not match agentId");
  });

  it.each(["mismatched", "unknown"])("rejects %s agents before session mutations", async (mode) => {
    const context = createContext({ globalScope: true });
    const unknown = mode === "unknown";
    const params = unknown
      ? { key: "agent:typo:main" }
      : { key: "agent:main:main", agentId: "work" };
    const message = unknown
      ? 'Unknown agent id "typo"'
      : 'agent "work" does not match session key agent "main"';
    for (const method of ["sessions.patch", "sessions.delete", "sessions.compact"] as const) {
      const respond = await callSessions(
        method,
        { ...params, ...(method === "sessions.patch" ? { label: unknown ? "Typo" : "Work" } : {}) },
        { context },
      );
      expectRespondErrorMessage(respond, message);
    }
  });

  it("protects bare global when its fixed-store owner is inferred", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const context = createContext({
        extra: {
          getRuntimeConfig: () => fixedStoreOwnershipConfig(state.statePath("shared.sqlite")),
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
});

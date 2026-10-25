import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
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
  expect(chatAbortMock).toHaveBeenCalledWith(expect.objectContaining({ params }));
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

function expectAbortEvent(
  broadcast: ReturnType<typeof vi.fn>,
  sessionKey: string,
  agentId: string,
  extra: object = {},
  options: object = {},
) {
  expect(broadcast).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({ sessionKey, reason: "abort", ...extra }),
    new Set(["conn-1"]),
    {
      agentId,
      dropIfSlow: true,
      sessionEventSubscriptionKeys: [`agent:${agentId}:global`],
      ...options,
    },
  );
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

  it.each([
    [
      "agent:beta:dashboard:target",
      "beta",
      undefined,
      [{ id: "main", default: true }, { id: "beta" }],
    ],
    ["main", "work", "work", [{ id: "work" }]],
  ] as const)(
    "preserves runId-only aborts for %s owned by %s",
    async (key, agentId, runAgentId, agents) => {
      const context = createContext({
        agents: [...agents],
        activeRuns: [["run", createActiveRun(key, { agentId: runAgentId })]],
      });
      await abort({ runId: "run" }, context);
      expectChatAbortParams({ sessionKey: key, runId: "run", agentId });
    },
  );

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
    };

    await abort({ key: "global", runId: "run-global" }, context);

    expectChatAbortParams({ sessionKey: "global", runId: "run-global", agentId: "work" });
    expectAbortEvent(broadcastToConnIds, "global", "work", { agentId: "work" });
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
      },
    });
    projectSession(context, { key, agentId: "main", sessionId: "weixin-session" });

    try {
      const respond = await abort({ key }, context);
      expectAbortResponse(respond);

      expect(weixinOperation.abortSignal.aborted).toBe(true);
      expect(telegramOperation.abortSignal.aborted).toBe(false);
      expectAbortEvent(
        broadcastToConnIds,
        key,
        "main",
        { hasActiveRun: false },
        {
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
    [false, false],
    [true, false],
    [false, true],
  ])("applies MCP stop ownership (clearQueued=%s, global=%s)", async (clearQueued, globalScope) => {
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

  it.each([
    [{ key: "global", agentId: "work" }, undefined],
    [{ key: "global" }, [{ id: "main" }, { id: "work", default: true }]],
    [{ key: "agent:work:main" }, undefined],
  ] satisfies Array<[Record<string, string>, { id: string; default?: boolean }[] | undefined]>)(
    "subscribes global events with %j",
    async (params, agents) => {
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
    },
  );

  it("rejects key-based aborts when key agent does not match agentId", async () => {
    const context = createContext({
      agents: [{ id: "main", default: true }, { id: "beta" }],
    });
    const respond = await abort({ key: "agent:beta:main", agentId: "main" }, context);

    expect(chatAbortMock).not.toHaveBeenCalled();
    expectRespondErrorMessage(respond, "session key agent does not match agentId");
  });

  it.each([
    [
      { key: "agent:main:main", agentId: "work" },
      'agent "work" does not match session key agent "main"',
    ],
    [{ key: "agent:typo:main" }, 'Unknown agent id "typo"'],
    [{ key: "global", agentId: "typo" }, 'Unknown agent id "typo"'],
  ] as const)("rejects %j before session mutations", async (params, message) => {
    const context = createContext({ globalScope: true });
    for (const method of ["sessions.patch", "sessions.delete", "sessions.compact"] as const) {
      const respond = await callSessions(
        method,
        { ...params, ...(method === "sessions.patch" ? { label: "Updated" } : {}) },
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
});

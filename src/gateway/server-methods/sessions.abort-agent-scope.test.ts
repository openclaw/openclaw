import { expectDefined } from "@openclaw/normalization-core";
/**
 * Tests that session abort requests stay scoped to the targeted agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/run-state.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createWorkerInferenceCancellationService } from "../worker-environments/inference-control.test-helpers.js";
import { workerService } from "./environments.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const chatAbortMock = vi.fn();
const resolveSessionKeyForRunMock = vi.fn();
const isEmbeddedAgentRunInProgressMock = vi.fn();
const abortEmbeddedAgentRunMock = vi.fn();
const clearSessionQueuesMock = vi.fn();
const loadSessionEntryMock = vi.fn((sessionKey: string, _opts?: { agentId?: string }) => ({
  canonicalKey: sessionKey,
}));

vi.mock("../server-session-key.js", () => ({
  resolveSessionKeyForRun: (...args: unknown[]) => resolveSessionKeyForRunMock(...args),
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
    loadSessionEntry: (...args: unknown[]) =>
      loadSessionEntryMock(...(args as [string, { agentId?: string }?])),
    loadGatewaySessionEntryReadOnly: (...args: unknown[]) =>
      loadSessionEntryMock(...(args as [string, { agentId?: string }?])),
  };
});

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
    isEmbeddedAgentRunInProgress: (...args: unknown[]) => isEmbeddedAgentRunInProgressMock(...args),
    resolveEmbeddedAgentRunProgressState: (...args: unknown[]) =>
      isEmbeddedAgentRunInProgressMock(...args) ? "running" : undefined,
    resolveEmbeddedAgentSessionProgressState: (...args: unknown[]) =>
      isEmbeddedAgentRunInProgressMock(...args) ? "running" : undefined,
  };
});

vi.mock("../../auto-reply/reply/queue/cleanup.js", () => ({
  clearSessionQueues: (...args: unknown[]) => clearSessionQueuesMock(...args),
}));

import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import { sessionCompactHandlers } from "./sessions-compact.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { sessionReadHandlers } from "./sessions-read.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import {
  createActiveRun,
  createBetaRunContext,
  createGlobalWorkRunContext,
  createContext,
} from "./sessions.abort-agent-scope.test-support.js";

function createRespond(): RespondFn {
  return vi.fn() as unknown as RespondFn;
}

const sessionHandlers = {
  ...sessionAbortHandlers,
  ...sessionCompactHandlers,
  ...sessionDeleteHandlers,
  ...sessionMutationHandlers,
  ...sessionReadHandlers,
  ...sessionSubscriptionHandlers,
};

async function callSessions(
  method: keyof typeof sessionHandlers,
  params: Record<string, unknown>,
  options: {
    context: GatewayRequestContext;
    respond?: RespondFn;
    reqId?: string;
    client?: GatewayClient | null;
  },
): Promise<RespondFn> {
  const respond = options.respond ?? createRespond();
  await expectDefined(
    sessionHandlers[method],
    "sessionHandlers[method] test invariant",
  )({
    req: { id: options.reqId ?? `req-${method}` } as never,
    params,
    respond,
    context: options.context,
    client: options.client ?? null,
    isWebchatConnect: () => false,
  });
  await flushPendingSessionsChangedEvents(options.context);
  return respond;
}

function expectChatAbortParams(params: Record<string, unknown>): void {
  expect(chatAbortMock).toHaveBeenCalledTimes(1);
  expect(chatAbortMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ params }));
}

function expectRespondErrorMessage(respond: RespondFn, message: string): void {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ message }));
}

function mockChatSuccess(mock: typeof chatAbortMock, payload: Record<string, unknown>): void {
  mock.mockImplementationOnce(
    (
      { respond }: { respond: RespondFn },
      lifecycle?: { onAuthorizedAfterQueuedAbort?: () => boolean },
    ) => {
      const additionalAborted = lifecycle?.onAuthorizedAfterQueuedAbort?.() ?? false;
      respond(true, additionalAborted ? { ...payload, aborted: true } : payload);
    },
  );
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
    storePath: "/tmp/openclaw-sessions.json",
    store: { [row.key]: { sessionId: row.sessionId, updatedAt: 1 } },
  });
  projections.add(projection);
  bindSessionRowProjection(context, () => projection);
}

vi.mock("../../agents/subagents/registry/subagent-registry-state.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/subagents/registry/subagent-registry-state.js")
  >()),
  persistSubagentRunsToDisk: () => {},
  persistSubagentRunsToDiskOrThrow: () => {},
}));

describe("sessions.abort agent scope", () => {
  afterEach(() => {
    for (const projection of projections) {
      projection.dispose();
    }
    projections.clear();
    resetSubagentRegistryForTests({ persist: false });
  });

  beforeEach(() => {
    chatAbortMock.mockReset();
    resolveSessionKeyForRunMock.mockReset();
    loadSessionEntryMock.mockReset();
    isEmbeddedAgentRunInProgressMock.mockReset();
    isEmbeddedAgentRunInProgressMock.mockReturnValue(false);
    abortEmbeddedAgentRunMock.mockReset();
    clearSessionQueuesMock.mockReset();
    clearSessionQueuesMock.mockReturnValue({ followupCleared: 0, laneCleared: 0, keys: [] });
  });

  it("does not abort an active run whose session key belongs to another requested agent", async () => {
    const activeRun = createActiveRun("agent:beta:dashboard:target");
    const context = createBetaRunContext(activeRun);
    const respond = await callSessions(
      "sessions.abort",
      { runId: "run-beta", agentId: "main" },
      { context, reqId: "req-1" },
    );

    expect(resolveSessionKeyForRunMock).toHaveBeenCalledWith("run-beta", { agentId: "main" });
    expect(chatAbortMock).not.toHaveBeenCalled();
    expect(activeRun.controller.signal.aborted).toBe(false);
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      abortedRunId: null,
      status: "no-active-run",
    });
  });

  it("aborts the exact embedded owner without entering chat.abort", async () => {
    const sessionKey = "agent:main:telegram:direct:user";
    const abort = vi.fn();
    const handle: EmbeddedAgentQueueHandle = {
      runId: "run-embedded",
      abort,
      isAborted: () => false,
      isCompacting: () => false,
      isStreaming: () => true,
      queueMessage: async () => undefined,
    };
    setActiveEmbeddedRun("session-embedded", handle, sessionKey);
    loadSessionEntryMock.mockImplementationOnce(() => ({
      canonicalKey: sessionKey,
      entry: { sessionId: "session-embedded" },
    }));
    try {
      const respond = await callSessions(
        "sessions.abort",
        { key: sessionKey, runId: "run-embedded" },
        {
          context: createContext({
            extra: { getSessionEventSubscriberConnIds: () => new Set() },
          }),
        },
      );

      expect(chatAbortMock).not.toHaveBeenCalled();
      expect(abort).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(true, {
        ok: true,
        abortedRunId: "run-embedded",
        status: "aborted",
      });
    } finally {
      clearActiveEmbeddedRun("session-embedded", handle, sessionKey);
    }
  });

  it("rejects an embedded run ID owned by another session", async () => {
    const ownerKey = "agent:main:telegram:direct:owner";
    const requestedKey = "agent:main:telegram:direct:other";
    const abort = vi.fn();
    const handle: EmbeddedAgentQueueHandle = {
      runId: "run-embedded",
      abort,
      isAborted: () => false,
      isCompacting: () => false,
      isStreaming: () => true,
      queueMessage: async () => undefined,
    };
    setActiveEmbeddedRun("session-owner", handle, ownerKey);
    loadSessionEntryMock.mockImplementationOnce(() => ({
      canonicalKey: requestedKey,
      entry: { sessionId: "session-other" },
    }));
    try {
      const respond = await callSessions(
        "sessions.abort",
        { key: requestedKey, runId: "run-embedded" },
        { context: createContext() },
      );

      expect(abort).not.toHaveBeenCalled();
      expectRespondErrorMessage(respond, "runId does not match session");
    } finally {
      clearActiveEmbeddedRun("session-owner", handle, ownerKey);
    }
  });

  it("marks listed sessions active when the embedded or channel reply run registry owns the session id", async () => {
    const context = createContext({
      extra: { loadGatewayModelCatalog: vi.fn().mockResolvedValue([]) },
    });
    projectSession(context, {
      key: "agent:main:openclaw-weixin:direct:user",
      agentId: "main",
      sessionId: "sess-weixin",
    });
    isEmbeddedAgentRunInProgressMock.mockImplementation(
      (sessionId: string) => sessionId === "sess-weixin",
    );

    const respond = await callSessions(
      "sessions.list",
      { agentId: "main" },
      { context, reqId: "req-channel-active" },
    );

    expect(isEmbeddedAgentRunInProgressMock).toHaveBeenCalledWith(
      "sess-weixin",
      expect.objectContaining({ agentId: "main" }),
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

    await callSessions("sessions.abort", { runId: "run-beta" }, { context, reqId: "req-2" });

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expectChatAbortParams({
      sessionKey: "agent:beta:dashboard:target",
      runId: "run-beta",
      agentId: "beta",
    });
  });

  it("kills controlled subagents after the parent run has already ended", async () => {
    const actualChatAbort =
      await vi.importActual<typeof import("./chat-abort-handler.js")>("./chat-abort-handler.js");
    chatAbortMock.mockImplementationOnce(actualChatAbort.handleChatAbortRequestWithLifecycle);
    const childSessionKey = "agent:main:subagent:orphaned-after-parent-stop";
    addSubagentRunForTests({
      runId: "run-orphaned-child",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterAgentId: "main",
      requesterTurnRunId: "ended-parent-run",
      task: "orphaned child",
      cleanup: "keep",
      createdAt: Date.now() - 2_000,
      startedAt: Date.now() - 1_000,
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

    const respond = await callSessions(
      "sessions.abort",
      { key: "agent:main:main" },
      { context, reqId: "req-orphaned-child" },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      { ok: true, abortedRunId: null, status: "aborted" },
      undefined,
      undefined,
    );
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
      endedReason: "subagent-killed",
      killReconciliation: { suppressTaskDelivery: true },
    });
  });

  it("resolves runId-only worker aborts to the owning session", async () => {
    mockChatSuccess(chatAbortMock, { ok: true, aborted: true, runIds: ["run-worker"] });
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

    await callSessions("sessions.abort", { runId: "run-worker" }, { context });

    expectChatAbortParams({
      sessionKey: "agent:work:dashboard:worker",
      runId: "run-worker",
      agentId: "work",
    });
    expect(context.dedupe?.size).toBe(0);
  });

  it("aborts global-scope active runs for non-default agents", async () => {
    const activeRun = createActiveRun("global", { agentId: "work" });
    const context = createGlobalWorkRunContext(activeRun);
    resolveSessionKeyForRunMock.mockReturnValue("global");

    await callSessions(
      "sessions.abort",
      { runId: "run-global", agentId: "work" },
      { context, reqId: "req-global" },
    );

    expect(resolveSessionKeyForRunMock).toHaveBeenCalledWith("run-global", { agentId: "work" });
    expectChatAbortParams({ sessionKey: "global", runId: "run-global", agentId: "work" });
  });

  it("uses the active run agent for key and runId global aborts without agentId", async () => {
    const activeRun = createActiveRun("global", { agentId: "work" });
    const context = createGlobalWorkRunContext(activeRun);

    await callSessions(
      "sessions.abort",
      { key: "global", runId: "run-global" },
      { context, reqId: "req-global-key-run" },
    );

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expectChatAbortParams({ sessionKey: "global", runId: "run-global", agentId: "work" });
  });

  it("emits selected global abort changes with agent scope", async () => {
    const activeRun = createActiveRun("global", { agentId: "work" });
    const broadcastToConnIds = vi.fn();
    chatAbortMock.mockImplementationOnce(
      async ({ respond: abortRespond }: { respond: RespondFn }) => {
        abortRespond(true, { ok: true, aborted: true, runIds: ["run-global"] });
      },
    );
    const context = createContext({
      activeRuns: [["run-global", activeRun]],
      globalScope: true,
      extra: {
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        broadcastToConnIds,
        dedupe: new Map(),
      },
    });

    await callSessions(
      "sessions.abort",
      { key: "global", runId: "run-global" },
      { context, reqId: "req-global-abort-event" },
    );

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "global",
        agentId: "work",
        reason: "abort",
      }),
      new Set(["conn-1"]),
      { agentId: "work", dropIfSlow: true },
    );
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
    mockChatSuccess(chatAbortMock, { ok: true, aborted: false, runIds: [] });
    loadSessionEntryMock.mockImplementationOnce((sessionKey: string) => ({
      canonicalKey: sessionKey,
      entry: { sessionId: "weixin-session" },
    }));
    const context = createContext({
      extra: {
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        broadcastToConnIds,
        dedupe: new Map(),
      },
    });
    projectSession(context, {
      key: "agent:main:openclaw-weixin:direct:wechat-user",
      agentId: "main",
      sessionId: "weixin-session",
    });

    try {
      const respond = await callSessions(
        "sessions.abort",
        { key: "agent:main:openclaw-weixin:direct:wechat-user" },
        { context, reqId: "req-reply-only-abort" },
      );

      expect(respond).toHaveBeenCalledWith(
        true,
        { ok: true, abortedRunId: null, status: "aborted" },
        undefined,
        undefined,
      );
      expect(clearSessionQueuesMock).not.toHaveBeenCalled();
      expect(abortEmbeddedAgentRunMock).toHaveBeenCalledWith("weixin-session");
      expect(weixinOperation.abortSignal.aborted).toBe(true);
      expect(telegramOperation.abortSignal.aborted).toBe(false);
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({
          hasActiveRun: false,
          sessionKey: "agent:main:openclaw-weixin:direct:wechat-user",
          reason: "abort",
        }),
        new Set(["conn-1"]),
        {
          agentId: "main",
          dropIfSlow: true,
          sessionKeys: ["agent:main:openclaw-weixin:direct:wechat-user"],
        },
      );
    } finally {
      weixinOperation.complete();
      telegramOperation.complete();
    }
  });

  it("preserves queued work while also aborting the exact active reply run", async () => {
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
    mockChatSuccess(chatAbortMock, { ok: true, aborted: true, runIds: ["visible-run"] });
    loadSessionEntryMock.mockImplementationOnce((sessionKey: string) => ({
      canonicalKey: sessionKey,
      entry: { sessionId: "weixin-session" },
    }));
    const context = createContext({
      extra: {
        dedupe: new Map(),
        getSessionEventSubscriberConnIds: () => new Set(),
      },
    });

    try {
      const respond = await callSessions(
        "sessions.abort",
        { key: "agent:main:openclaw-weixin:direct:wechat-user" },
        { context, reqId: "req-visible-and-reply-abort" },
      );

      expect(clearSessionQueuesMock).not.toHaveBeenCalled();
      expect(abortEmbeddedAgentRunMock).toHaveBeenCalledWith("weixin-session");
      expect(weixinOperation.abortSignal.aborted).toBe(true);
      expect(telegramOperation.abortSignal.aborted).toBe(false);
      expect(respond).toHaveBeenCalledWith(
        true,
        { ok: true, abortedRunId: "visible-run", status: "aborted" },
        undefined,
        undefined,
      );
    } finally {
      weixinOperation.complete();
      telegramOperation.complete();
    }
  });

  it("clears queued session work even when no embedded run remains active", async () => {
    mockChatSuccess(chatAbortMock, { ok: true, aborted: false, runIds: [] });
    loadSessionEntryMock.mockImplementationOnce((sessionKey: string) => ({
      canonicalKey: sessionKey,
      entry: { sessionId: "queued-session" },
    }));
    clearSessionQueuesMock.mockReturnValueOnce({
      followupCleared: 1,
      laneCleared: 0,
      keys: ["queued-session"],
    });
    const context = createContext({
      extra: {
        getSessionEventSubscriberConnIds: () => new Set(),
      },
    });

    const respond = await callSessions(
      "sessions.abort",
      {
        key: "agent:main:openclaw-weixin:direct:queued-user",
        clearQueued: true,
      },
      { context, reqId: "req-queued-only-abort" },
    );

    expect(clearSessionQueuesMock).toHaveBeenCalledWith([
      "agent:main:openclaw-weixin:direct:queued-user",
      "agent:main:openclaw-weixin:direct:queued-user",
      "queued-session",
    ]);
    expect(abortEmbeddedAgentRunMock).toHaveBeenCalledWith("queued-session");
    expect(respond).toHaveBeenCalledWith(
      true,
      { ok: true, abortedRunId: null, status: "aborted" },
      undefined,
      undefined,
    );
  });

  it.each([
    { clearQueued: false, globalScope: false },
    { clearQueued: true, globalScope: false },
    { clearQueued: false, globalScope: true },
  ])(
    "applies MCP stop ownership (clearQueued=$clearQueued, global=$globalScope)",
    async ({ clearQueued, globalScope }) => {
      const { getOrCreateSessionMcpRuntime, unopenedMcpConfig } =
        await import("../../agents/agent-bundle-mcp-manager.test-support.js");
      const { getSessionMcpRuntimeManagerForTesting } =
        await import("../../agents/agent-bundle-mcp-manager-api.js");
      const manager = getSessionMcpRuntimeManagerForTesting();
      const sessionKey = globalScope ? "global" : "agent:main:idle-mcp";
      mockChatSuccess(chatAbortMock, { ok: true, aborted: false, runIds: [] });
      loadSessionEntryMock.mockImplementationOnce(() => ({
        canonicalKey: sessionKey,
        entry: { sessionId: "idle-mcp" },
      }));
      try {
        const runtime = await getOrCreateSessionMcpRuntime({
          sessionId: "idle-mcp",
          sessionKey,
          workspaceDir: "/workspace",
          cfg: unopenedMcpConfig,
          manifestRegistry: { plugins: [] },
        });
        await callSessions(
          "sessions.abort",
          { key: sessionKey, clearQueued, ...(globalScope ? { agentId: "work" } : {}) },
          { context: createContext({ globalScope }) },
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
    mockChatSuccess(chatAbortMock, { ok: true, aborted: false, runIds: [] });
    loadSessionEntryMock.mockImplementationOnce(() => ({ canonicalKey: sessionKey }));
    clearSessionQueuesMock.mockReturnValueOnce({
      followupCleared: 1,
      laneCleared: 0,
      keys: [sessionKey],
    });
    const context = createContext({
      extra: {
        getSessionEventSubscriberConnIds: () => new Set(),
      },
    });

    const respond = await callSessions(
      "sessions.abort",
      { key: sessionKey, clearQueued: true },
      { context, reqId: "req-key-only-queue-abort" },
    );

    expect(clearSessionQueuesMock).toHaveBeenCalledWith([sessionKey, sessionKey, undefined]);
    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      { ok: true, abortedRunId: null, status: "aborted" },
      undefined,
      undefined,
    );
  });

  it("keeps explicit runId aborts targeted instead of clearing the whole session", async () => {
    mockChatSuccess(chatAbortMock, { ok: true, aborted: false, runIds: [] });
    loadSessionEntryMock.mockImplementationOnce((sessionKey: string) => ({
      canonicalKey: sessionKey,
      entry: { sessionId: "persisted-session" },
    }));
    const context = createContext();

    const respond = await callSessions(
      "sessions.abort",
      {
        key: "agent:main:openclaw-weixin:direct:wechat-user",
        runId: "missing-run",
      },
      { context, reqId: "req-targeted-run-abort" },
    );

    expect(clearSessionQueuesMock).not.toHaveBeenCalled();
    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      { ok: true, abortedRunId: null, status: "no-active-run" },
      undefined,
      undefined,
    );
  });

  it("clears legacy aliases only when they belong to the selected agent", async () => {
    loadSessionEntryMock.mockImplementationOnce((sessionKey: string) => ({
      canonicalKey: sessionKey,
      entry: { sessionId: "work-session" },
    }));
    mockChatSuccess(chatAbortMock, { ok: true, aborted: false, runIds: [] });

    await callSessions(
      "sessions.abort",
      { key: "main", agentId: "work", clearQueued: true },
      {
        context: createContext({
          agents: [{ id: "work", default: true }, { id: "main" }],
        }),
        reqId: "req-owned-legacy-alias-abort",
      },
    );

    expect(clearSessionQueuesMock).toHaveBeenLastCalledWith([
      "agent:work:main",
      "main",
      "agent:work:main",
      "work-session",
    ]);

    clearSessionQueuesMock.mockClear();
    loadSessionEntryMock.mockImplementationOnce((sessionKey: string) => ({
      canonicalKey: sessionKey,
      entry: { sessionId: "work-session" },
    }));
    mockChatSuccess(chatAbortMock, { ok: true, aborted: false, runIds: [] });

    await callSessions(
      "sessions.abort",
      { key: "main", agentId: "work", clearQueued: true },
      { context: createContext(), reqId: "req-foreign-legacy-alias-abort" },
    );

    expect(clearSessionQueuesMock).toHaveBeenLastCalledWith([
      "agent:work:main",
      "agent:work:main",
      "work-session",
    ]);
  });

  it("leaves global-scope cleanup on chat.abort without an agent-qualified queue key", async () => {
    mockChatSuccess(chatAbortMock, { ok: true, aborted: false, runIds: [] });
    loadSessionEntryMock.mockImplementationOnce(() => ({
      canonicalKey: "global",
      entry: { sessionId: "work-global-session" },
    }));
    const context = createContext({ globalScope: true });

    const respond = await callSessions(
      "sessions.abort",
      { key: "global", agentId: "work", clearQueued: true },
      { context, reqId: "req-scoped-global-queue-abort" },
    );

    expectChatAbortParams({ sessionKey: "global", runId: undefined, agentId: "work" });
    expect(clearSessionQueuesMock).not.toHaveBeenCalled();
    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      { ok: true, abortedRunId: null, status: "no-active-run" },
      undefined,
      undefined,
    );
  });

  it("forwards selected-agent scope for key-based global aborts", async () => {
    const context = createContext({ globalScope: true });

    await callSessions(
      "sessions.abort",
      { key: "global", agentId: "work" },
      { context, reqId: "req-global-key" },
    );

    expectChatAbortParams({ sessionKey: "global", runId: undefined, agentId: "work" });
  });

  it("infers selected-agent global aborts from agent-prefixed aliases", async () => {
    loadSessionEntryMock.mockImplementationOnce(() => ({ canonicalKey: "global" }));
    const context = createContext({ globalScope: true });

    await callSessions(
      "sessions.abort",
      { key: "agent:work:main" },
      { context, reqId: "req-global-key-alias" },
    );

    expect(loadSessionEntryMock).toHaveBeenCalledWith("agent:work:main", { agentId: "work" });
    expectChatAbortParams({ sessionKey: "global", runId: undefined, agentId: "work" });
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
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true, key: "global" }, undefined);
  });

  it("aborts an active legacy-key run owned by the configured default agent", async () => {
    const activeRun = createActiveRun("main");
    const context = createContext({
      activeRuns: [["run-work", activeRun]],
      agents: [{ id: "work", default: true }],
    });

    await callSessions("sessions.abort", { runId: "run-work" }, { context, reqId: "req-3" });

    expect(resolveSessionKeyForRunMock).not.toHaveBeenCalled();
    expectChatAbortParams({ sessionKey: "main", runId: "run-work", agentId: "work" });
  });

  it("rejects key-based aborts when key agent does not match agentId", async () => {
    const context = createContext({
      agents: [{ id: "main", default: true }, { id: "beta" }],
    });
    const respond = await callSessions(
      "sessions.abort",
      { key: "agent:beta:main", agentId: "main" },
      { context, reqId: "req-4" },
    );

    expect(chatAbortMock).not.toHaveBeenCalled();
    expectRespondErrorMessage(respond, "session key agent does not match agentId");
  });

  it("rejects explicit agentId mismatches before session mutations", async () => {
    const context = createContext({ globalScope: true });

    for (const [method, params] of [
      ["sessions.patch", { key: "agent:main:main", agentId: "work", label: "Work" }],
      ["sessions.delete", { key: "agent:main:main", agentId: "work" }],
      ["sessions.compact", { key: "agent:main:main", agentId: "work" }],
    ] as const) {
      const respond = await callSessions(method, params, { context, reqId: `req-${method}` });

      expectRespondErrorMessage(respond, 'agent "work" does not match session key agent "main"');
    }
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
    const context = createContext({ agents: [{ id: "main", default: true }] });
    const respond = await callSessions(
      "sessions.patch",
      { key: "global", agentId: "work", label: "Work" },
      { context, reqId: "req-unknown-agent-patch" },
    );

    expectRespondErrorMessage(respond, 'Unknown agent id "work"');
  });

  it("rejects unknown inferred selected-global aliases before session mutations", async () => {
    const context = createContext({ globalScope: true });

    for (const [method, params] of [
      ["sessions.patch", { key: "agent:typo:main", label: "Typo" }],
      ["sessions.delete", { key: "agent:typo:main" }],
      ["sessions.compact", { key: "agent:typo:main" }],
    ] as const) {
      const respond = await callSessions(method, params, {
        context,
        reqId: `req-${method}-unknown-alias`,
      });

      expectRespondErrorMessage(respond, 'Unknown agent id "typo"');
    }
  });

  it("applies agentId to legacy key-based abort aliases", async () => {
    const context = createContext();

    await callSessions(
      "sessions.abort",
      { key: "main", agentId: "work" },
      { context, reqId: "req-5" },
    );

    expectChatAbortParams({
      sessionKey: "agent:work:main",
      runId: undefined,
      agentId: "work",
    });
  });

  it("does not use a raw legacy key alias that belongs to another agent", async () => {
    const activeRun = createActiveRun("main");
    const context = createContext({ activeRuns: [["run-work", activeRun]] });

    await callSessions(
      "sessions.abort",
      { key: "main", agentId: "work" },
      { context, reqId: "req-6" },
    );

    expectChatAbortParams({
      sessionKey: "agent:work:main",
      runId: undefined,
      agentId: "work",
    });
  });

  it("keeps the raw legacy key alias when it belongs to the requested agent", async () => {
    const activeRun = createActiveRun("main");
    const context = createContext({
      activeRuns: [["run-work", activeRun]],
      agents: [{ id: "work", default: true }, { id: "main" }],
    });

    await callSessions(
      "sessions.abort",
      { key: "main", agentId: "work" },
      { context, reqId: "req-7" },
    );

    expectChatAbortParams({ sessionKey: "main", runId: undefined, agentId: "work" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { ChatLog } from "./components/chat-log.js";
import type { TuiBackend } from "./tui-backend.js";
import { createCommandHandlers } from "./tui-command-handlers.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import {
  createBaseState,
  createTestSessionActions,
  makeTui,
  makeTuiBackend,
  makeTuiSessionDescription,
} from "./tui-session-actions-test-support.js";
import {
  readTuiSessionProjectionScope,
  reduceTuiSessionProjection,
} from "./tui-session-projection.js";
import {
  getPendingSubmitAcceptedRunId,
  getPendingSubmitDraft,
  type TuiPendingSubmit,
} from "./tui-submit-state.js";
import type { TuiHistoryLoadResult, TuiStateAccess } from "./tui-types.js";

type TuiSessionDescription = Awaited<ReturnType<TuiBackend["describeSession"]>>;
type ActionContext = Parameters<typeof createTestSessionActions>[0];
type HarnessContext = Omit<ActionContext, "client" | "state" | "chatLog" | "tui" | "btw">;
const defaultChatMocks = [
  "addSystem",
  "addUser",
  "addLiveUser",
  "addPendingUser",
  "finalizeAssistant",
  "clearAll",
] as const;
const historyChatMocks = [...defaultChatMocks, "updateAssistant", "startTool"] as const;
type ChatMockMethod = (typeof historyChatMocks)[number];
function createHarness({
  state: stateOverrides = {},
  backend = {},
  context = {},
  chatLog: providedChatLog,
  mockChatMethods = providedChatLog ? [] : defaultChatMocks,
}: {
  state?: Partial<TuiStateAccess>;
  backend?: Partial<TuiBackend>;
  context?: HarnessContext | ((state: TuiStateAccess) => HarnessContext);
  chatLog?: ChatLog;
  mockChatMethods?: readonly ChatMockMethod[];
} = {}) {
  const state = createBaseState(stateOverrides);
  const client = makeTuiBackend(backend);
  const tui = makeTui();
  const chatLog = providedChatLog ?? new ChatLog();
  for (const method of mockChatMethods) {
    vi.spyOn(chatLog, method).mockImplementation(vi.fn());
  }
  const btw = { clear: vi.fn(), showResult: vi.fn() };
  const spies = {
    updateHeader: vi.fn(),
    updateFooter: vi.fn(),
    updateAutocompleteProvider: vi.fn(),
    setActivityStatus: vi.fn(),
    invalidateRunOwnership: vi.fn(),
    clearLocalRunIds: vi.fn(),
    rememberSessionKey: vi.fn(),
    requestRender: vi.spyOn(tui, "requestRender"),
    addSystem: vi.spyOn(chatLog, "addSystem"),
    addUser: vi.spyOn(chatLog, "addUser"),
    clearAll: vi.spyOn(chatLog, "clearAll"),
    updateAssistant: vi.spyOn(chatLog, "updateAssistant"),
    finalizeAssistant: vi.spyOn(chatLog, "finalizeAssistant"),
    addPendingUser: vi.spyOn(chatLog, "addPendingUser"),
  };
  const shared = {
    ...spies,
    client,
    chatLog,
    tui,
    btw,
    state,
    ...(typeof context === "function" ? context(state) : context),
  };
  const actions = createTestSessionActions(shared);
  return {
    ...shared,
    ...actions,
    spies,
    events: (overrides: Partial<Parameters<typeof createEventHandlers>[0]> = {}) =>
      createEventHandlers({ ...shared, loadHistory: actions.loadHistory, ...overrides }),
    commands: (overrides: Partial<Parameters<typeof createCommandHandlers>[0]> = {}) =>
      createCommandHandlers({
        ...shared,
        ...actions,
        opts: {},
        deliverDefault: false,
        openOverlay: (component) => tui.showOverlay(component),
        closeOverlay: () => tui.hideOverlay(),
        requestExit: vi.fn(),
        ...overrides,
      }),
  };
}
const renderChat = (chatLog: ChatLog) => chatLog.render(120).join("\n");
const flushImmediate = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const mainSession = { key: "agent:main:main", sessionId: "session-main" };
const description = (
  session: TuiSessionDescription["session"],
  defaults: TuiSessionDescription["defaults"] = {},
) => makeTuiSessionDescription({ session, defaults });
const session = (sessionId: string, fields: Record<string, unknown> = {}) => ({
  key: mainSession.key,
  sessionId,
  ...fields,
});
const historyResult = (messages: unknown[] = [], fields: Record<string, unknown> = {}) => ({
  messages,
  ...fields,
});
const mockHistory = (messages: unknown[] = [], fields: Record<string, unknown> = {}) =>
  vi.fn().mockResolvedValue(historyResult(messages, fields));
const switchSession = (name: "A" | "B") => ({
  key: `agent:main:${name}`,
  sessionId: `session-${name.toLowerCase()}`,
  updatedAt: name === "A" ? 10 : 20,
});
const switchHistory = (name: "A" | "B", extra: Record<string, unknown> = {}) =>
  historyResult([{ role: "user", content: `message from ${name}` }], {
    sessionId: switchSession(name).sessionId,
    sessionInfo: switchSession(name),
    ...extra,
  });
const assistantEvent = (
  runId: string,
  sessionKey: string,
  seq: number,
  state: "delta" | "final",
  text: string,
) => ({
  runId,
  sessionKey,
  seq,
  state,
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const expectCalls = (count: number, ...spies: unknown[]) => {
  for (const spy of spies) {
    expect(spy).toHaveBeenCalledTimes(count);
  }
};
const assistantMessage = (content: string, id?: string, seq?: number) => ({
  role: "assistant",
  content,
  ...(id ? { __openclaw: { id, seq } } : {}),
});
const userMessage = (
  content: string,
  id: string,
  seq: number,
  imported: Record<string, unknown> = {},
) => ({
  role: "user",
  content,
  __openclaw: { id, seq, ...imported },
});
const createDeferredHistory = (
  stateOverrides: Partial<TuiStateAccess> = { currentSessionId: "session-main" },
  chatLog = new ChatLog(),
) => {
  const history = createDeferred<unknown>();
  return {
    history,
    ...createHarness({
      state: stateOverrides,
      backend: { describeSession: vi.fn(), loadHistory: vi.fn(() => history.promise) },
      chatLog,
    }),
  };
};

describe("tui session actions", () => {
  const acceptedSubmit = (
    runId: string,
    draftText: string | null = "pending",
  ): TuiPendingSubmit => ({ phase: "accepted", runId, draftText });
  const persistLiveUser = (
    state: TuiStateAccess,
    params: { text: string; messageId: string; messageSeq?: number; runId?: string },
  ) =>
    reduceTuiSessionProjection(state, {
      type: "messagePersisted",
      message: {
        role: "user",
        content: params.text,
        __openclaw: {
          id: params.messageId,
          ...(params.messageSeq !== undefined ? { seq: params.messageSeq } : {}),
          ...(params.runId ? { idempotencyKey: `${params.runId}:user` } : {}),
        },
      },
      scope: readTuiSessionProjectionScope(state),
    });

  const sendPendingUser = (state: TuiStateAccess, runId: string, text: string) =>
    reduceTuiSessionProjection(state, {
      type: "sendPending",
      message: { role: "user", content: text, idempotencyKey: `${runId}:user` },
      runId,
      scope: readTuiSessionProjectionScope(state),
    });

  it("keeps the cached agent roster when a refresh fails", async () => {
    const cachedAgents = [{ id: "cached", name: "Cached Agent" }];
    const agentNames = new Map([["cached", "Cached Agent"]]);
    const { state, refreshAgents, spies } = createHarness({
      mockChatMethods: ["addSystem"],
      state: {
        agentDefaultId: "cached",
        sessionMainKey: "cached-main",
        sessionScope: "per-sender",
        agents: cachedAgents,
        currentAgentId: "cached",
      },
      backend: {
        listAgents: vi.fn().mockRejectedValue(new Error("gateway unavailable")),
      },
      context: { agentNames },
    });

    await expect(refreshAgents()).resolves.toBe(false);
    expect(state.agents).toBe(cachedAgents);
    expect(state).toMatchObject({
      agentDefaultId: "cached",
      sessionMainKey: "cached-main",
      sessionScope: "per-sender",
    });
    expect([...agentNames]).toEqual([["cached", "Cached Agent"]]);
    expect(spies.addSystem).toHaveBeenCalledWith("agents list failed: gateway unavailable");
  });

  it("retires the previous global agent before replacement history resolves", async () => {
    const history = createDeferred<unknown>();
    const loadHistory = vi.fn(() => history.promise);
    const { state, chatLog, setSession, spies } = createHarness({
      mockChatMethods: [],
      backend: { loadHistory },
      context: (currentState) => ({
        resolveSessionSelection: vi.fn((_raw?: string, agentId = currentState.currentAgentId) => ({
          key: "global",
          agentId,
        })),
      }),
      state: {
        currentAgentId: "research",
        currentSessionKey: "global",
        currentSessionId: "research-session",
        activeChatRunId: "research-run",
        pendingSubmit: acceptedSubmit("research-pending", "private draft"),
        historyLoaded: true,
        sessionInfo: {
          displayName: "Research secret",
          updatedAt: 100,
          modelProvider: "anthropic",
          model: "private-research-model",
          thinkingLevel: "high",
          thinkingLevels: [{ id: "high", label: "high" }],
          agentRuntime: { id: "private-runtime", source: "agent" },
          responseUsage: "full",
          effectiveResponseUsage: "full",
          contextTokens: 999_999,
          verboseLevel: "full",
        },
      },
    });
    sendPendingUser(state, "research-pending", "private draft");
    chatLog.addUser("PRIVATE RESEARCH HISTORY");

    const switching = setSession("", "ops");

    expect(state).toMatchObject({
      currentAgentId: "ops",
      currentSessionKey: "global",
      currentSessionId: null,
      activeChatRunId: null,
      pendingSubmit: null,
      historyLoaded: false,
    });
    expect(state.sessionInfo).toEqual({});
    expect(state.sessionProjection?.entries).toEqual([]);
    expect(renderChat(chatLog)).not.toContain("PRIVATE RESEARCH HISTORY");
    expectCalls(1, spies.invalidateRunOwnership, spies.clearLocalRunIds);
    expect(loadHistory).toHaveBeenCalledWith({ sessionKey: "global", agentId: "ops", limit: 200 });

    history.resolve({
      messages: [],
      sessionInfo: { sessionId: "ops-session" },
      defaults: { modelProvider: "openai", model: "gpt-5.4", contextTokens: 128_000 },
    });
    await switching;
    expect(state).toMatchObject({
      currentSessionId: "ops-session",
      sessionInfo: {
        modelProvider: "openai",
        model: "gpt-5.4",
        contextTokens: 128_000,
      },
    });
    expect([
      state.sessionInfo.thinkingLevel,
      state.sessionInfo.agentRuntime,
      state.sessionInfo.responseUsage,
    ]).toEqual([undefined, undefined, undefined]);
  });

  it("returns success after applying a normalized fresh agent roster", async () => {
    const agentNames = new Map([["cached", "Cached Agent"]]);
    const { state, refreshAgents, spies } = createHarness({
      state: { agents: [{ id: "cached", name: "Cached Agent" }], currentAgentId: "cached" },
      backend: {
        listAgents: vi.fn().mockResolvedValue({
          defaultId: " Team Lead ",
          mainKey: " Primary ",
          scope: "per-sender",
          agents: [
            { id: " Team Lead ", name: " Lead Agent " },
            { id: " System Agent ", kind: "system", name: " System Agent " },
          ],
        }),
      },
      context: (currentState) => ({
        agentNames,
        resolveSessionSelection: vi.fn((_raw?: string, agentId = currentState.currentAgentId) => ({
          key: `agent:${agentId}:${currentState.sessionMainKey}`,
          agentId,
        })),
      }),
    });

    await expect(refreshAgents()).resolves.toBe(true);
    expect(state).toMatchObject({
      agentDefaultId: "team-lead",
      sessionMainKey: "primary",
      sessionScope: "per-sender",
      currentAgentId: "team-lead",
      currentSessionKey: "agent:team-lead:primary",
    });
    expect(state.agents).toEqual([
      { id: "team-lead", kind: undefined, name: "Lead Agent" },
      { id: "system-agent", kind: "system", name: "System Agent" },
    ]);
    expect([...agentNames]).toEqual([
      ["team-lead", "Lead Agent"],
      ["system-agent", "System Agent"],
    ]);
    expectCalls(1, spies.updateHeader, spies.updateFooter);
  });

  it.each(["success", "failure"])(
    "does not publish a superseded picker roster %s",
    async (outcome) => {
      const pendingRoster = createDeferred<Awaited<ReturnType<TuiBackend["listAgents"]>>>();
      const cachedAgents = [{ id: "research", name: "Research" }];
      const agentNames = new Map([["research", "Research"]]);
      const { state, refreshAgents, addSystem } = createHarness({
        mockChatMethods: ["addSystem"],
        backend: { listAgents: vi.fn(() => pendingRoster.promise) },
        context: { agentNames },
        state: {
          agentDefaultId: "research",
          agents: cachedAgents,
          currentAgentId: "research",
          currentSessionKey: "agent:research:incident",
        },
      });
      let ownsRefresh = true;

      const refresh = refreshAgents(() => ownsRefresh);
      ownsRefresh = false;
      if (outcome === "success") {
        pendingRoster.resolve({
          defaultId: "ops",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "ops", name: "Operations" }],
        });
      } else {
        pendingRoster.reject(new Error("obsolete roster request failed"));
      }
      await refresh;

      expect(state).toMatchObject({
        currentAgentId: "research",
        currentSessionKey: "agent:research:incident",
      });
      expect(state.agents).toBe(cachedAgents);
      expect([...agentNames]).toEqual([["research", "Research"]]);
      expect(addSystem).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      scope: "per-sender" as const,
      previousKey: "agent:research:main",
      nextKey: "agent:ops:main",
    },
    {
      scope: "global" as const,
      previousKey: "global",
      nextKey: "global",
    },
  ])(
    "retires the complete $scope session when its selected agent disappears",
    async ({ scope, previousKey, nextKey }) => {
      const { state, refreshAgents, spies, btw, client } = createHarness({
        mockChatMethods: ["clearAll"],
        backend: {
          loadHistory: vi.fn(),
          listAgents: vi.fn().mockResolvedValue({
            defaultId: "ops",
            mainKey: "main",
            scope,
            agents: [{ id: "ops" }],
          }),
        },
        context: (currentState) => ({
          resolveSessionSelection: vi.fn(
            (_raw?: string, agentId = currentState.currentAgentId) => ({
              key: scope === "global" ? "global" : `agent:${agentId}:main`,
              agentId,
            }),
          ),
        }),
        state: {
          agents: [{ id: "research" }],
          currentAgentId: "research",
          currentSessionKey: previousKey,
          currentSessionId: "old-session",
          sessionMainKey: "main",
          sessionScope: scope,
          activeChatRunId: "old-run",
          pendingSubmit: acceptedSubmit("pending-run"),
          historyLoaded: true,
          sessionInfo: { updatedAt: 100, thinkingLevel: "high", verboseLevel: "full" },
        },
      });
      sendPendingUser(state, "pending-run", "stale prompt");

      await expect(refreshAgents()).resolves.toBe(true);

      expect(state).toMatchObject({
        currentAgentId: "ops",
        currentSessionKey: nextKey,
        currentSessionId: null,
        activeChatRunId: null,
        pendingSubmit: null,
        historyLoaded: false,
        sessionInfo: {},
      });
      expect([state.sessionInfo.thinkingLevel, state.sessionInfo.verboseLevel]).toEqual([
        undefined,
        undefined,
      ]);
      expect(state.sessionProjection?.entries).toEqual([]);
      expectCalls(
        1,
        spies.invalidateRunOwnership,
        spies.clearLocalRunIds,
        spies.clearAll,
        btw.clear,
      );
      expect(client.loadHistory).not.toHaveBeenCalled();
    },
  );

  it("preserves the complete selected session when its agent remains in the roster", async () => {
    const resolveSessionSelection = vi.fn();
    const { state, refreshAgents, invalidateRunOwnership } = createHarness({
      backend: {
        listAgents: vi.fn().mockResolvedValue({
          defaultId: "ops",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "ops" }, { id: "research" }],
        }),
      },
      context: { resolveSessionSelection },
      state: {
        agents: [{ id: "research" }],
        currentAgentId: "research",
        currentSessionKey: "agent:research:incident",
        currentSessionId: "current-session",
        sessionScope: "per-sender",
        activeChatRunId: "current-run",
        pendingSubmit: acceptedSubmit("pending-run"),
        historyLoaded: true,
        sessionInfo: { updatedAt: 100, thinkingLevel: "high" },
      },
    });
    sendPendingUser(state, "pending-run", "current prompt");
    const previousProjection = state.sessionProjection;

    await expect(refreshAgents()).resolves.toBe(true);

    expect(state).toMatchObject({
      currentAgentId: "research",
      currentSessionKey: "agent:research:incident",
      currentSessionId: "current-session",
      activeChatRunId: "current-run",
      historyLoaded: true,
      sessionInfo: { updatedAt: 100, thinkingLevel: "high" },
    });
    expect(state.pendingSubmit).toEqual(acceptedSubmit("pending-run"));
    expect(state.sessionProjection).toBe(previousProjection);
    expectCalls(0, invalidateRunOwnership, resolveSessionSelection);
  });

  it("coalesces refresh bursts and applies the latest result", async () => {
    const firstResult = createDeferred<TuiSessionDescription>();
    const secondResult = createDeferred<TuiSessionDescription>();
    const describeSession = vi
      .fn()
      .mockReturnValueOnce(firstResult.promise)
      .mockReturnValueOnce(secondResult.promise);

    const { state, refreshSessionInfo, updateFooter, updateAutocompleteProvider, requestRender } =
      createHarness({
        mockChatMethods: ["addSystem"],
        backend: { describeSession },
      });

    const first = refreshSessionInfo();
    const second = refreshSessionInfo();
    const third = refreshSessionInfo();

    await flushImmediate();
    expect(describeSession).toHaveBeenCalledTimes(1);
    expect(describeSession).toHaveBeenNthCalledWith(1, {
      sessionKey: "agent:main:main",
    });

    firstResult.resolve(
      description({
        ...mainSession,
        sessionId: "session-old",
        model: "old",
        modelProvider: "anthropic",
      }),
    );

    await flushImmediate();

    expect(describeSession).toHaveBeenCalledTimes(2);

    secondResult.resolve(
      description({
        ...mainSession,
        sessionId: "session-current",
        model: "Minimax-M2.7",
        modelProvider: "minimax",
      }),
    );

    await Promise.all([first, second, third]);
    expect(describeSession).toHaveBeenCalledTimes(2);

    expect(state).toMatchObject({
      sessionInfo: { model: "Minimax-M2.7" },
      currentSessionId: "session-current",
    });
    expectCalls(2, updateAutocompleteProvider, updateFooter, requestRender);
  });

  it("skips UI work when session refresh metadata is unchanged", async () => {
    const metadata = { model: "sonnet-4.6", modelProvider: "anthropic", totalTokens: 42 };
    const describeSession = vi
      .fn()
      .mockResolvedValue(description({ key: mainSession.key, ...metadata, updatedAt: 200 }));
    const { state, refreshSessionInfo, updateFooter, updateAutocompleteProvider, requestRender } =
      createHarness({
        backend: { describeSession },
        state: {
          sessionInfo: { ...metadata, updatedAt: 100 },
        },
      });

    await refreshSessionInfo();

    expect(state.sessionInfo.updatedAt).toBe(200);
    expectCalls(0, updateAutocompleteProvider, updateFooter, requestRender);
  });

  it("keeps patched model selection when a refresh returns an older snapshot", async () => {
    const oldModel = { model: "old-model", modelProvider: "ollama", updatedAt: 100 };
    const describeSession = vi
      .fn()
      .mockResolvedValue(description({ key: mainSession.key, ...oldModel }));

    const { state, applySessionInfoFromPatch, refreshSessionInfo } = createHarness({
      backend: { describeSession },
      state: {
        sessionInfo: {
          ...oldModel,
          fastMode: true,
          verboseLevel: "full",
          traceLevel: "off",
          reasoningLevel: "stream",
        },
      },
    });

    applySessionInfoFromPatch({
      ok: true,
      key: "agent:main:main",
      entry: {
        sessionId: "session-1",
        model: "new-model",
        modelProvider: "openai",
        updatedAt: 200,
        traceLevel: "raw",
      },
    });

    expect(state.sessionInfo).toMatchObject({ model: "new-model", modelProvider: "openai" });

    await refreshSessionInfo();

    expect(state.sessionInfo).toMatchObject({
      model: "new-model",
      modelProvider: "openai",
      updatedAt: 200,
      fastMode: true,
      verboseLevel: "full",
      traceLevel: "raw",
      reasoningLevel: "stream",
    });
  });

  it("applies the runtime-aware thinking projection returned by session patches", () => {
    const { state, applySessionInfoFromPatch } = createHarness();
    const resolved = {
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: { id: "openclaw", source: "session-key" },
      thinkingLevel: "ultra",
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "ultra", label: "ultra" },
      ],
    } satisfies NonNullable<Awaited<ReturnType<TuiBackend["patchSession"]>>["resolved"]>;

    applySessionInfoFromPatch({
      ok: true,
      key: "agent:main:main",
      entry: { sessionId: "session-1", updatedAt: 200 },
      resolved: structuredClone(resolved),
    });

    expect(state.sessionInfo).toMatchObject(resolved);
  });

  it.each([
    {
      name: "another session",
      currentAgentId: "main",
      currentSessionKey: "agent:main:current",
      resultKey: "agent:main:previous",
    },
    {
      name: "the same request key owned by another agent",
      currentAgentId: "main",
      currentSessionKey: "agent:main:main",
      resultKey: "agent:work:main",
    },
  ])(
    "ignores a session patch belonging to $name",
    ({ currentAgentId, currentSessionKey, resultKey }) => {
      const { state, applySessionInfoFromPatch, updateHeader, updateFooter } = createHarness({
        state: {
          currentAgentId,
          currentSessionKey,
          sessionInfo: { model: "current-model", modelProvider: "openai" },
        },
      });

      applySessionInfoFromPatch({
        ok: true,
        path: "/sessions/patch",
        key: resultKey,
        entry: { model: "stale-model", modelProvider: "anthropic" },
      });

      expect(state).toMatchObject({
        currentSessionKey,
        currentAgentId,
        sessionInfo: { model: "current-model", modelProvider: "openai" },
      });
      expectCalls(0, updateHeader, updateFooter);
    },
  );

  it("adopts the canonical key for a patch belonging to the selected alias", () => {
    const { state, applySessionInfoFromPatch, updateHeader } = createHarness({
      state: { currentSessionKey: "main" },
    });

    applySessionInfoFromPatch({
      ok: true,
      path: "/sessions/patch",
      key: "agent:main:main",
      entry: { model: "gpt-5.6-luna", modelProvider: "openai" },
    });

    expect(state).toMatchObject({
      currentSessionKey: mainSession.key,
      currentAgentId: "main",
      sessionInfo: { model: "gpt-5.6-luna" },
    });
    expect(updateHeader).toHaveBeenCalledOnce();
  });

  it("clears the footer goal when the current session has no row yet", async () => {
    const describeSession = vi.fn().mockResolvedValue({
      defaults: { model: "gpt-5.4", modelProvider: "openai", contextTokens: 272000 },
      session: null,
    });
    const { state, refreshSessionInfo } = createHarness({
      backend: { describeSession },
      state: {
        sessionInfo: {
          goal: {
            schemaVersion: 1,
            id: "goal-1",
            objective: "old goal",
            status: "active",
            createdAt: 1,
            updatedAt: 1,
            tokenStart: 0,
            tokenStartFresh: true,
            tokensUsed: 0,
            continuationTurns: 0,
          },
        },
      },
    });

    await refreshSessionInfo();

    expect(state.sessionInfo.goal).toBeUndefined();
    expect(state.sessionInfo).toMatchObject({
      model: "gpt-5.4",
      modelProvider: "openai",
      contextTokens: 272000,
    });
  });

  const createRunMessageHarness = () => {
    const describeSession = vi.fn().mockResolvedValue(description(session("session-main")));
    const h = createHarness({
      backend: { describeSession },
      state: { activeChatRunId: "run-1", currentSessionId: "session-main" },
    });
    const events = h.events({
      refreshSessionInfo: h.refreshSessionInfo,
      applySessionEventRow: h.applySessionEventRow,
    });
    const message = (updatedAt: number, row?: Record<string, unknown>) =>
      events.handleSessionMessageEvent({
        sessionKey: mainSession.key,
        sessionId: "session-main",
        updatedAt,
        message: { role: "toolResult", content: [] },
        ...(row ? { session: session("session-main", { updatedAt, ...row }) } : {}),
      });
    return { describeSession, state: h.state, events, message };
  };

  it("applies session rows from run messages without describing the session", async () => {
    const { describeSession, state, events, message } = createRunMessageHarness();
    try {
      for (let toolCall = 1; toolCall <= 10; toolCall += 1) {
        message(100 + toolCall, { totalTokens: toolCall * 100, contextTokens: 120000 });
      }
      await flushImmediate();

      expect(describeSession).not.toHaveBeenCalled();
      expect(state.sessionInfo).toMatchObject({ totalTokens: 1000, contextTokens: 120000 });
    } finally {
      events.dispose();
    }
  });

  it.each([
    { name: "carries no row", row: undefined },
    { name: "carries a row the session picker hides", row: { archived: true } },
  ])("describes the session once when a run message $name", async ({ row }) => {
    const { describeSession, events, message } = createRunMessageHarness();
    try {
      message(200, row);
      await vi.waitFor(() => expect(describeSession).toHaveBeenCalledOnce());
      await flushImmediate();
      expect(describeSession).toHaveBeenCalledOnce();
    } finally {
      events.dispose();
    }
  });

  it.each([
    { snapshot: "stale", included: false, scrollback: false, userSeq: 3, replySeq: 4 },
    { snapshot: "includes live user", included: true, scrollback: false, userSeq: 1, replySeq: 2 },
    { snapshot: "full scrollback", included: false, scrollback: true, userSeq: 19, replySeq: 20 },
  ])(
    "reconciles an authoritative live user against $snapshot history",
    async ({ included, scrollback, userSeq, replySeq }) => {
      const chatLog = new ChatLog(scrollback ? 20 : undefined);
      chatLog.addUser("Deleted prompt from an earlier branch", {
        messageId: "deleted-history-user",
      });
      const {
        history: deferredHistory,
        state,
        loadHistory,
      } = createDeferredHistory(undefined, chatLog);

      const loading = loadHistory();
      persistLiveUser(state, {
        text: "Browser prompt received during refresh",
        messageId: "live-user",
        messageSeq: userSeq,
        runId: "live-run",
      });
      deferredHistory.resolve({
        sessionId: "session-main",
        sessionInfo: mainSession,
        messages: [
          ...(scrollback
            ? Array.from({ length: 18 }, (_, index) =>
                userMessage(`Earlier history ${index + 1}`, `history-user-${index + 1}`, index + 1),
              )
            : [
                userMessage(
                  included ? "Browser prompt received during refresh" : "Current branch prompt",
                  included ? "live-user" : "current-history-user",
                  included ? userSeq : 2,
                ),
              ]),
          assistantMessage("Current branch reply", "current-assistant", replySeq),
        ],
      });

      await expect(loading).resolves.toMatchObject({ loaded: true });
      const rendered = renderChat(chatLog);
      expect(rendered).not.toContain("Deleted prompt from an earlier branch");
      expect(rendered.match(/Browser prompt received during refresh/g)).toHaveLength(1);
      expect(rendered).toContain("Current branch reply");
      expect(rendered.indexOf("Browser prompt received during refresh")).toBeLessThan(
        rendered.indexOf("Current branch reply"),
      );
      if (scrollback) {
        expect(chatLog.children).toHaveLength(20);
      }
    },
  );

  it("preserves distinct imported live users through a stale history snapshot", async () => {
    const { history: deferredHistory, state, chatLog, loadHistory } = createDeferredHistory();

    const loading = loadHistory();
    for (const [index, cliSessionId] of ["first-cli-session", "second-cli-session"].entries()) {
      reduceTuiSessionProjection(state, {
        type: "messagePersisted",
        message: userMessage(`Imported live prompt ${index + 1}`, "shared-provider-id", index + 1, {
          importedFrom: "claude-cli",
          cliSessionId,
          externalId: "shared-provider-id",
        }),
        scope: readTuiSessionProjectionScope(state),
      });
    }
    deferredHistory.resolve({
      sessionId: "session-main",
      sessionInfo: mainSession,
      messages: [assistantMessage("Current branch reply", "imported-live-reply", 3)],
    });

    await expect(loading).resolves.toMatchObject({ loaded: true });
    const rendered = renderChat(chatLog);
    expect(rendered.match(/Imported live prompt 1/g)).toHaveLength(1);
    expect(rendered.match(/Imported live prompt 2/g)).toHaveLength(1);
    expect(rendered).toContain("Current branch reply");
  });

  it("keeps native and separately imported users with the same provider-local ID distinct", async () => {
    const sharedId = "provider-local-user";
    const imported = { importedFrom: "claude-cli", externalId: sharedId };
    const { chatLog, loadHistory } = createHarness({
      mockChatMethods: [],
      state: { currentSessionId: "session-main" },
      backend: {
        describeSession: vi.fn(),
        loadHistory: vi.fn().mockResolvedValue({
          sessionId: "session-main",
          sessionInfo: mainSession,
          messages: [
            userMessage("Native canonical prompt", sharedId, 1),
            userMessage("First imported prompt", sharedId, 2, {
              ...imported,
              cliSessionId: "first-cli-session",
            }),
            userMessage("Second imported prompt", sharedId, 3, {
              ...imported,
              cliSessionId: "second-cli-session",
            }),
            userMessage("First partially imported prompt", sharedId, 4, imported),
            userMessage("Second partially imported prompt", sharedId, 5, imported),
          ],
        }),
      },
    });

    await expect(loadHistory()).resolves.toMatchObject({ loaded: true });

    const rendered = renderChat(chatLog);
    for (const text of [
      "Native canonical prompt",
      "First imported prompt",
      "Second imported prompt",
      "First partially imported prompt",
      "Second partially imported prompt",
    ]) {
      expect(rendered.split(text)).toHaveLength(2);
    }
  });

  it("preserves new-session live users without leaking the previous session during a switch", async () => {
    const { history: deferredHistory, state, chatLog, setSession } = createDeferredHistory();
    persistLiveUser(state, {
      text: "Private prompt from previous session",
      messageId: "previous-user",
      runId: "previous-run",
    });
    const switching = setSession("agent:main:other");
    persistLiveUser(state, {
      text: "Browser prompt in selected session",
      messageId: "other-user",
      messageSeq: 1,
      runId: "other-run",
    });
    deferredHistory.resolve({
      sessionId: "session-other",
      sessionInfo: { key: "agent:main:other", sessionId: "session-other" },
      messages: [assistantMessage("Other session reply", "other-assistant", 2)],
    });

    await switching;
    const rendered = renderChat(chatLog);
    expect(rendered).toContain("Browser prompt in selected session");
    expect(rendered.match(/Browser prompt in selected session/g)).toHaveLength(1);
    expect(rendered).toContain("Other session reply");
    expect(rendered.indexOf("Browser prompt in selected session")).toBeLessThan(
      rendered.indexOf("Other session reply"),
    );
    expect(rendered).not.toContain("Private prompt from previous session");
  });

  it("discards old live users when a same-key history response rotates the session id", async () => {
    const {
      history: deferredHistory,
      state,
      chatLog,
      loadHistory,
    } = createDeferredHistory({
      currentSessionId: "session-before-reset",
    });

    const loading = loadHistory();
    persistLiveUser(state, {
      text: "Private prompt from before reset",
      messageId: "before-reset-user",
      runId: "before-reset-run",
    });
    deferredHistory.resolve({
      sessionId: "session-after-reset",
      sessionInfo: { key: "agent:main:main", sessionId: "session-after-reset" },
      messages: [{ role: "assistant", content: "Fresh session reply" }],
    });

    await expect(loading).resolves.toMatchObject({ loaded: true });
    const rendered = renderChat(chatLog);
    expect(rendered).toContain("Fresh session reply");
    expect(rendered).not.toContain("Private prompt from before reset");
  });

  it("accepts older session snapshots after switching session keys", async () => {
    const metadata = {
      key: "agent:main:other",
      model: "session-model",
      modelProvider: "openai",
      updatedAt: 50,
    };
    const describeSession = vi.fn().mockResolvedValue(description(metadata));
    const loadHistory = mockHistory([], {
      sessionId: "session-2",
      sessionInfo: session("session-2", {
        ...metadata,
        thinkingLevel: "medium",
        contextTokens: 120_000,
      }),
    });
    const { state, setSession, btw, setActivityStatus } = createHarness({
      backend: { describeSession, loadHistory },
      state: {
        historyLoaded: true,
        sessionInfo: {
          model: "previous-model",
          modelProvider: "anthropic",
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          updatedAt: 500,
        },
      },
    });

    await setSession("agent:main:other");

    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(loadHistory).toHaveBeenCalledWith({
      sessionKey: "agent:main:other",
      limit: 200,
    });
    expect(state).toMatchObject({
      currentSessionKey: "agent:main:other",
      currentSessionId: "session-2",
      sessionInfo: {
        model: "session-model",
        modelProvider: "openai",
        updatedAt: 50,
        thinkingLevel: "medium",
        contextTokens: 120_000,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      },
    });
    expect(describeSession).not.toHaveBeenCalled();
    expect(btw.clear).toHaveBeenCalled();
  });

  it("renders a fresh session total as 0 (not '?') when totalTokensFresh is set", async () => {
    const describeSession = vi.fn().mockResolvedValue({ session: null });
    const loadHistory = mockHistory([], {
      sessionId: "session-fresh",
      // The Gateway strips fresh 0 but keeps this flag (#93798).
      sessionInfo: session("session-fresh", {
        key: "agent:main:fresh",
        model: "session-model",
        modelProvider: "openai",
        totalTokensFresh: true,
        updatedAt: 60,
      }),
    });
    const { state, setSession } = createHarness({
      backend: { describeSession, loadHistory },
      state: {
        historyLoaded: true,
        sessionInfo: {
          totalTokens: 3,
          updatedAt: 500,
        },
      },
    });

    await setSession("agent:main:fresh");

    expect(state.sessionInfo).toMatchObject({ totalTokens: 0, totalTokensFresh: true });
  });

  it.each([
    ["a different session", false, undefined, false],
    ["a same-session replacement with exact active runs", true, ["run-next"], false],
    ["a same-session concurrent run", true, ["run-previous", "run-next"], true],
    ["a same-session run with unknown active membership", true, undefined, true],
    ["a same-session run with malformed active membership", true, ["run-next", 42], true],
  ])(
    "reconciles previous run ownership when restoring %s",
    async (_description, sameSession, activeRunIds, preservesOld) => {
      vi.useFakeTimers();
      try {
        const previousSessionKey = "agent:main:previous";
        const nextSessionKey = sameSession ? previousSessionKey : "agent:main:next";
        const previousRunId = "run-previous";
        const nextRunId = "run-next";
        const h = createHarness({
          mockChatMethods: [],
          state: {
            currentSessionKey: previousSessionKey,
            currentSessionId: "session-previous",
            historyLoaded: true,
          },
          context: (state) => ({
            setActivityStatus: vi.fn((text: string) => {
              state.activityStatus = text;
            }),
            invalidateRunOwnership: () => handlers.dispose(),
          }),
          backend: {
            describeSession: vi.fn(),
            loadHistory: mockHistory([], {
              sessionId: sameSession ? "session-previous" : "session-next",
              sessionInfo: session(sameSession ? "session-previous" : "session-next", {
                key: nextSessionKey,
                activeRunIds,
                updatedAt: 1,
              }),
              inFlightRun: { runId: nextRunId, text: "new partial" },
            }),
          },
        });
        const { state, chatLog, setActivityStatus } = h;
        const addPendingSystem = vi.spyOn(chatLog, "addPendingSystem");
        let loadSelectedHistory: () => Promise<TuiHistoryLoadResult> = async () => ({
          loaded: false,
        });
        const handlers = h.events({
          loadHistory: () => loadSelectedHistory(),
          streamingWatchdogMs: 100,
        });
        handlers.handleChatEvent(
          assistantEvent(previousRunId, previousSessionKey, 1, "delta", "old partial"),
        );
        expect(state.activeChatRunId).toBe(previousRunId);

        loadSelectedHistory = async () => {
          const reconcileMembership = handlers.captureHistoryRunMembership();
          const result = await h.loadHistory();
          if (result.loaded) {
            reconcileMembership(result.activeRunIds);
          }
          return result;
        };

        if (sameSession) {
          handlers.pauseStreamingWatchdog();
          handlers.reconnectStreamingWatchdog();
          const recovered = await loadSelectedHistory();
          expect(recovered.loaded).toBe(true);
          if (recovered.loaded) {
            handlers.reconnectStreamingWatchdog(recovered.runOutcome);
          }
        } else {
          await h.setSession(nextSessionKey);
        }
        expect(state.activeChatRunId).toBe(nextRunId);

        handlers.handleChatEvent(
          assistantEvent(nextRunId, nextSessionKey, 2, "final", "new final"),
        );

        expect(state.activeChatRunId).toBe(preservesOld ? previousRunId : null);
        if (preservesOld) {
          expect(setActivityStatus).toHaveBeenLastCalledWith("running");
        } else {
          expect(setActivityStatus).toHaveBeenLastCalledWith("idle", "completed");
        }
        vi.advanceTimersByTime(101);
        expect(addPendingSystem).toHaveBeenCalledTimes(preservesOld ? 1 : 0);
        if (sameSession && !preservesOld) {
          handlers.handleChatEvent(
            assistantEvent(previousRunId, previousSessionKey, 3, "final", "late complete reply"),
          );
          expect(renderChat(chatLog)).toContain("late complete reply");
          expect(state.activeChatRunId).toBeNull();
        }
        handlers.dispose();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["agent:main:main", "main"])(
    "preserves run ownership when reselecting the same session as %s",
    async (selectedKey) => {
      const sessionKey = "agent:main:main";
      const activeRunId = "run-active";
      const pendingRunId = "run-pending";
      const pendingText = "still waiting for the Gateway";
      const loadHistory = vi.fn();
      const { state, chatLog, setSession, invalidateRunOwnership, clearLocalRunIds } =
        createHarness({
          mockChatMethods: [],
          context: (currentState) => ({
            setActivityStatus: (text) => {
              currentState.activityStatus = text;
            },
          }),

          backend: { describeSession: vi.fn(), loadHistory },
          state: {
            currentSessionKey: sessionKey,
            activeChatRunId: activeRunId,
            pendingSubmit: acceptedSubmit(pendingRunId, pendingText),
            activityStatus: "streaming",
            historyLoaded: true,
          },
        });
      sendPendingUser(state, pendingRunId, pendingText);
      chatLog.addPendingUser(pendingRunId, pendingText);

      await setSession(selectedKey);

      expect(state).toMatchObject({ activeChatRunId: activeRunId, activityStatus: "streaming" });
      expect(state.pendingSubmit).toEqual(acceptedSubmit(pendingRunId, pendingText));
      expect(renderChat(chatLog)).toContain(pendingText);
      expectCalls(0, invalidateRunOwnership, clearLocalRunIds, loadHistory);
    },
  );

  it("reloads the current session when its initial history never loaded", async () => {
    const sessionKey = "agent:main:main";
    const loadHistory = mockHistory([], { sessionId: "session-main", sessionInfo: mainSession });
    const { state, setSession } = createHarness({
      backend: { describeSession: vi.fn(), loadHistory },
      state: { currentSessionKey: sessionKey, historyLoaded: false },
    });

    await setSession(sessionKey);

    expect(loadHistory).toHaveBeenCalledOnce();
    expect(state.historyLoaded).toBe(true);
  });

  it("adopts an in-flight run with no buffered text (Codex) and shows streaming", async () => {
    const loadHistory = mockHistory([], {
      sessionId: "session-bg",
      inFlightRun: { runId: "run-bg", text: "" },
    });
    const { state, setSession, updateAssistant, setActivityStatus } = createHarness({
      mockChatMethods: [
        "addSystem",
        "clearAll",
        "addUser",
        "finalizeAssistant",
        "updateAssistant",
        "startTool",
      ],

      backend: { describeSession: vi.fn(), loadHistory },
      state: { currentSessionKey: "agent:main:other" },
    });

    await setSession("agent:main:main");

    expect(updateAssistant).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-bg");
    expect(setActivityStatus).toHaveBeenLastCalledWith("streaming");
  });

  it.each(["history success", "history failure", "description success"] as const)(
    "ignores a superseded switch during %s",
    async (outcome) => {
      const historyA = createDeferred<unknown>();
      const historyB = createDeferred<unknown>();
      const sessionInfoA = createDeferred<TuiSessionDescription>();
      const sessionInfoB = createDeferred<TuiSessionDescription>();
      const loadHistory = vi
        .fn()
        .mockImplementationOnce(() => historyA.promise)
        .mockImplementationOnce(() => historyB.promise);
      const describeSession = vi.fn();
      if (outcome === "description success") {
        describeSession
          .mockReturnValueOnce(sessionInfoA.promise)
          .mockReturnValueOnce(sessionInfoB.promise);
      }
      const { state, setSession, addSystem, addUser } = createHarness({
        mockChatMethods: historyChatMocks,
        state: { currentSessionKey: "agent:main:home" },
        backend: { describeSession, loadHistory },
      });

      const firstSwitch = setSession("agent:main:A");
      if (outcome === "description success") {
        historyA.resolve(
          historyResult([{ role: "user", content: "message from A" }], { sessionId: "session-a" }),
        );
        await vi.waitFor(() => expect(describeSession).toHaveBeenCalledTimes(1));
      }
      const secondSwitch = setSession("agent:main:B");
      if (outcome === "description success") {
        historyB.resolve(
          historyResult([{ role: "user", content: "message from B" }], { sessionId: "session-b" }),
        );
        sessionInfoA.resolve(description(switchSession("A")));
        await vi.waitFor(() => expect(describeSession).toHaveBeenCalledTimes(2));
        sessionInfoB.resolve(description(switchSession("B")));
      } else {
        historyB.resolve(switchHistory("B"));
      }
      if (outcome === "history failure") {
        historyA.reject(new Error("history rpc aborted"));
      } else if (outcome === "history success") {
        historyA.resolve(
          switchHistory("A", { inFlightRun: { runId: "run-a", text: "stale A run" } }),
        );
      }

      await Promise.all([firstSwitch, secondSwitch]);

      expect(state).toMatchObject({
        currentSessionKey: "agent:main:B",
        currentSessionId: "session-b",
        ...(outcome === "description success" ? {} : { activeChatRunId: null }),
      });
      const renderedUsers = addUser.mock.calls.map((call) => call[0]);
      expect(renderedUsers).toContain("message from B");
      expect(renderedUsers).not.toContain("message from A");
      if (outcome === "description success") {
        expect(addSystem).not.toHaveBeenCalledWith(
          expect.stringContaining("session description failed"),
        );
      } else {
        const systemMessages = addSystem.mock.calls.map((call) => call[0]);
        expect(systemMessages.some((message) => message.includes("history failed"))).toBe(false);
      }
    },
  );

  it.each([
    {
      scenario: "shutdown cancellation",
      error: new DOMException("history loading stopped", "AbortError"),
      expectedMessages: [],
      expectedRenders: [],
    },
    {
      scenario: "backend failure",
      error: new Error("gateway unavailable"),
      expectedMessages: [["history failed: gateway unavailable"]],
      expectedRenders: [[true]],
    },
  ])(
    "renders only genuine history errors for $scenario",
    async ({ error, expectedMessages, expectedRenders }) => {
      const { loadHistory, addSystem, requestRender } = createHarness({
        mockChatMethods: ["addSystem"],
        backend: { loadHistory: vi.fn().mockRejectedValue(error) },
      });

      await expect(loadHistory()).resolves.toEqual({ loaded: false });
      expect(addSystem.mock.calls).toEqual(expectedMessages);
      expect(requestRender.mock.calls).toEqual(expectedRenders);
    },
  );

  it("ignores stale session info after switching away and back to the same key", async () => {
    const firstHistoryA = createDeferred<unknown>();
    const historyB = createDeferred<unknown>();
    const secondHistoryA = createDeferred<unknown>();
    const firstSessionInfoA = createDeferred<TuiSessionDescription>();
    const loadHistory = vi
      .fn()
      .mockImplementationOnce(() => firstHistoryA.promise)
      .mockImplementationOnce(() => historyB.promise)
      .mockImplementationOnce(() => secondHistoryA.promise);
    const describeSession = vi.fn(() => firstSessionInfoA.promise);
    const { state, setSession } = createHarness({
      state: { currentSessionKey: "agent:main:home" },
      backend: { describeSession, loadHistory },
    });

    const firstSwitchA = setSession("agent:main:A");
    firstHistoryA.resolve({ sessionId: "session-a-old", messages: [] });
    await vi.waitFor(() => expect(describeSession).toHaveBeenCalledTimes(1));

    const switchB = setSession("agent:main:B");
    historyB.resolve({
      sessionInfo: { key: "agent:main:B", sessionId: "session-b", updatedAt: 20 },
      messages: [],
    });
    await switchB;

    const secondSwitchA = setSession("agent:main:A");
    secondHistoryA.resolve({
      sessionInfo: {
        key: "agent:main:A",
        sessionId: "session-a-new",
        model: "new-model",
        updatedAt: 30,
      },
      messages: [],
    });
    await secondSwitchA;

    firstSessionInfoA.resolve(
      description({
        key: "agent:main:A",
        sessionId: "session-a-old",
        model: "old-model",
        updatedAt: 10,
      }),
    );
    await firstSwitchA;

    expect(state).toMatchObject({
      currentSessionKey: "agent:main:A",
      currentSessionId: "session-a-new",
      sessionInfo: { model: "new-model" },
    });
  });

  it("adopts a reset mutation's replacement key without reloading gateway history", () => {
    const loadHistory = mockHistory();
    const { state, applySessionMutationResult, addSystem, clearAll } = createHarness({
      mockChatMethods: ["addSystem", "clearAll"],
      backend: { loadHistory },
      state: {
        currentSessionKey: "old",
        currentSessionId: "old-session",
        sessionInfo: {
          model: "old-model",
          modelProvider: "old-provider",
        },
      },
    });

    const applied = applySessionMutationResult({
      ok: true,
      key: "agent:main:new",
      entry: {
        sessionId: "new-session",
        model: "new-model",
        modelProvider: "openai",
        updatedAt: 123,
      },
    });

    expect(applied).toBe(true);
    expect(loadHistory).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      currentSessionKey: "agent:main:new",
      currentSessionId: "new-session",
      sessionInfo: { model: "new-model", modelProvider: "openai", updatedAt: 123 },
      historyLoaded: true,
    });
    expect(clearAll).toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("session agent:main:new");
  });

  it.each(["none", "before adoption", "during refresh", "after acknowledgement"])(
    "keeps the reset acknowledgement with a notification %s",
    async (notification) => {
      const entry = { sessionId: "same-session", updatedAt: 20, totalTokens: 0 };
      const result = { ok: true, key: mainSession.key, entry };
      const refreshStarted = createDeferred();
      const refreshResult = createDeferred<TuiSessionDescription>();
      const resetResponse = createDeferred<typeof result>();
      const h = createHarness({
        mockChatMethods: [],
        state: {
          currentSessionId: "same-session",
          sessionGeneration: 4,
          historyLoaded: true,
          sessionInfo: { updatedAt: 10, totalTokens: 42 },
        },
        backend: {
          resetSession: vi.fn(() => resetResponse.promise),
          describeSession: vi.fn(() => {
            refreshStarted.resolve();
            return refreshResult.promise;
          }),
          loadHistory: vi.fn(async () => ({
            messages: [],
            sessionInfo: { key: result.key, ...entry },
          })),
        },
      });
      const { state, chatLog } = h;
      chatLog.addUser("before reset");
      const setActivityStatus = (text: string) => {
        state.activityStatus = text;
      };
      const histories: Array<Promise<TuiHistoryLoadResult>> = [];
      const events = h.events({
        setActivityStatus,
        updateFooter: vi.fn(),
        loadHistory: () => {
          const history = h.loadHistory();
          histories.push(history);
          return history;
        },
        refreshSessionInfo: h.refreshSessionInfo,
      });
      const commands = h.commands({ setActivityStatus });
      const notify = () =>
        events.handleSessionsChangedEvent({
          sessionKey: result.key,
          agentId: "main",
          reason: "reset",
          ...entry,
        });
      try {
        const resetting = commands.handleCommand("/reset");
        resetResponse.resolve(result);
        if (notification === "before adoption") {
          notify();
        } else {
          await refreshStarted.promise;
          if (notification === "during refresh") {
            notify();
          }
        }
        refreshResult.resolve(description({ key: result.key, ...entry }));
        await resetting;
        if (notification === "after acknowledgement") {
          notify();
        }
        await Promise.all(histories);
        await vi.waitFor(() => {
          const rendered = renderChat(chatLog);
          expect(rendered).not.toContain("before reset");
          expect(rendered.match(/session agent:main:main reset/g)).toHaveLength(1);
        });
        expect(commands.resolveMessageAdmission("after reset")).toEqual({ status: "allowed" });
      } finally {
        events.dispose();
      }
    },
  );

  it("fences pre-reset history and session-info reads when reset commits", async () => {
    const history = createDeferred<unknown>();
    const sessionInfo = createDeferred<TuiSessionDescription>();
    const loadHistory = vi.fn(() => history.promise);
    const describeSession = vi.fn(() => sessionInfo.promise);
    const {
      state,
      addUser,
      clearAll,
      applySessionMutationResult,
      loadHistory: readHistory,
      refreshSessionInfo,
    } = createHarness({
      mockChatMethods: historyChatMocks,
      backend: { loadHistory, describeSession },
      state: {
        currentSessionId: "session-before-reset",
        sessionGeneration: 4,
        sessionInfo: { model: "model-before-reset", updatedAt: 10 },
      },
    });

    const staleHistory = readHistory();
    const staleSessionInfo = refreshSessionInfo();
    await vi.waitFor(() => {
      expect(loadHistory).toHaveBeenCalledOnce();
      expect(describeSession).toHaveBeenCalledOnce();
    });

    expect(
      applySessionMutationResult({
        ok: true,
        key: "agent:main:main",
        entry: {
          sessionId: "session-after-reset",
          model: "model-after-reset",
          updatedAt: 20,
        },
      }),
    ).toBe(true);

    history.resolve({
      sessionInfo: {
        key: "agent:main:main",
        sessionId: "session-before-reset",
        model: "stale-history-model",
        updatedAt: 10,
      },
      messages: [{ role: "user", content: "before reset" }],
    });
    sessionInfo.resolve(
      description({
        key: mainSession.key,
        sessionId: "session-before-reset",
        model: "stale-session-info-model",
        updatedAt: 10,
      }),
    );

    await expect(staleHistory).resolves.toEqual({ loaded: false });
    await staleSessionInfo;

    expect(state).toMatchObject({
      sessionGeneration: 5,
      currentSessionId: "session-after-reset",
      sessionInfo: { model: "model-after-reset" },
    });
    expect(addUser).not.toHaveBeenCalled();
    expect(clearAll).toHaveBeenCalledOnce();
  });

  it.each(["history", "description success", "description failure"] as const)(
    "discards an in-flight %s after an external same-key reset",
    async (outcome) => {
      const history = createDeferred<unknown>();
      const sessionInfo = createDeferred<TuiSessionDescription>();
      const h = createHarness({
        mockChatMethods: outcome === "history" ? historyChatMocks : ["addSystem"],
        backend:
          outcome === "history"
            ? { loadHistory: vi.fn(() => history.promise) }
            : { describeSession: vi.fn(() => sessionInfo.promise) },
        state: {
          currentSessionId: "session-before-reset",
          sessionGeneration: 4,
          sessionInfo: {
            model: "model-before-reset",
            ...(outcome === "history" ? {} : { updatedAt: 10 }),
          },
        },
      });
      const { state } = h;
      const stale = outcome === "history" ? h.loadHistory() : h.refreshSessionInfo();
      state.sessionGeneration = 5;
      state.currentSessionId = "session-after-reset";
      state.sessionInfo = {
        model: "model-after-reset",
        ...(outcome === "history" ? {} : { updatedAt: 20 }),
      };
      if (outcome === "description failure") {
        sessionInfo.reject(new Error("private previous-session details"));
      } else if (outcome === "description success") {
        sessionInfo.resolve(
          description({
            ...mainSession,
            sessionId: "session-before-reset",
            model: "private-old-model",
            updatedAt: 10,
          }),
        );
      } else {
        history.resolve(
          historyResult([{ role: "user", content: "PRIVATE OLD HISTORY" }], {
            sessionInfo: session("session-before-reset", { model: "private-old-model" }),
          }),
        );
      }
      if (outcome === "history") {
        await expect(stale).resolves.toEqual({ loaded: false });
        expectCalls(0, h.addUser, h.clearAll);
      } else {
        await stale;
        expect(h.addSystem).not.toHaveBeenCalled();
      }
      expect(state).toMatchObject({
        currentSessionId: "session-after-reset",
        sessionInfo: { model: "model-after-reset" },
      });
    },
  );

  it.each([
    {
      reason: "another selection",
      result: {
        ok: true,
        key: "agent:main:previous",
        entry: {
          sessionId: "stale-reset-session",
          model: "stale-model",
          modelProvider: "anthropic",
        },
      },
      requestSelection: { sessionKey: "agent:main:previous", agentId: "main" },
      historyLoaded: true,
    },
    {
      reason: "no replacement entry",
      result: { ok: true },
      requestSelection: undefined,
      historyLoaded: false,
    },
  ])(
    "does not fast-clear a reset result with $reason",
    ({ result, requestSelection, historyLoaded }) => {
      const { state, applySessionMutationResult, clearAll, addSystem, updateHeader } =
        createHarness({
          mockChatMethods: ["addSystem", "clearAll"],
          state: {
            currentSessionKey: "agent:main:current",
            currentSessionId: "current-session",
            historyLoaded,
            sessionInfo: { model: "current-model", modelProvider: "openai" },
          },
        });

      const applied = applySessionMutationResult(result, requestSelection);

      expect(applied).toBe(false);
      expect(state).toMatchObject({
        currentSessionKey: "agent:main:current",
        currentSessionId: "current-session",
        sessionInfo: { model: "current-model" },
        historyLoaded,
      });
      expectCalls(0, clearAll, addSystem, updateHeader);
    },
  );

  it("remembers the selected session after history loads", async () => {
    const describeSession = vi.fn().mockResolvedValue(description(mainSession));
    const loadHistory = mockHistory([], { sessionId: "session-main" });
    const {
      state,
      loadHistory: runLoadHistory,
      rememberSessionKey,
    } = createHarness({
      backend: { describeSession, loadHistory },
      state: { currentSessionKey: "main" },
    });

    await runLoadHistory();

    expect(state).toMatchObject({
      currentSessionId: "session-main",
      currentSessionKey: mainSession.key,
    });
    expect(rememberSessionKey).toHaveBeenCalledWith("agent:main:main");
  });

  it("preserves optimistic user messages across stale history rebuilds", async () => {
    const describeSession = vi.fn().mockResolvedValue(description(mainSession));
    const loadHistory = mockHistory(
      [
        { role: "user", content: "persisted", timestamp: 2_000 },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
      ],
      { sessionId: "session-main" },
    );
    const {
      state,
      spies,
      loadHistory: runLoadHistory,
      requestRender,
    } = createHarness({
      mockChatMethods: ["addSystem", "addUser", "addPendingUser", "finalizeAssistant", "clearAll"],
      backend: { describeSession, loadHistory },
      state: { currentSessionId: "session-main" },
    });
    sendPendingUser(state, "optimistic-run", "optimistic prompt");

    const result = await runLoadHistory();

    expect(spies.clearAll).toHaveBeenCalledWith();
    expect(spies.addUser).toHaveBeenCalledWith("persisted", { images: [] });
    expect(spies.addPendingUser).toHaveBeenCalledWith("optimistic-run", "optimistic prompt");
    expect(spies.finalizeAssistant).toHaveBeenCalledWith("reply", undefined, []);
    expect(requestRender).toHaveBeenCalledWith(true);
    expect(result).toEqual({
      loaded: true,
      runOutcome: { state: "completed" },
    });
  });

  it.each([
    {
      name: "interrupted",
      sessionInfo: { status: "killed", abortedLastRun: true },
      runOutcome: { state: "interrupted" },
    },
    {
      name: "failed",
      sessionInfo: { status: "failed", lastRunError: "provider failed" },
      runOutcome: { state: "failed", errorMessage: "provider failed" },
    },
  ])("projects a closed $name history outcome", async ({ sessionInfo, runOutcome }) => {
    const { loadHistory } = createHarness({
      backend: {
        describeSession: vi.fn(),
        loadHistory: mockHistory([], { sessionId: "session-main", sessionInfo }),
      },
    });

    await expect(loadHistory()).resolves.toEqual({ loaded: true, runOutcome });
  });

  it.each([
    { verboseLevel: "off", showsTool: false, showsOutput: false },
    { verboseLevel: "on", showsTool: true, showsOutput: false },
    { verboseLevel: "full", showsTool: true, showsOutput: true },
  ] as const)(
    "preserves $verboseLevel tool-output visibility when rebuilding history",
    async ({ verboseLevel, showsTool, showsOutput }) => {
      const privateOutput = "TUI_PRIVATE_TOOL_OUTPUT";
      const { chatLog, loadHistory } = createHarness({
        mockChatMethods: [],
        state: { sessionInfo: { verboseLevel } },
        backend: {
          describeSession: vi.fn(),
          loadHistory: vi.fn().mockResolvedValue({
            sessionId: "session-main",
            sessionInfo: {
              key: "agent:main:main",
              sessionId: "session-main",
              verboseLevel,
            },
            messages: [
              {
                role: "toolResult",
                toolCallId: "tool-private",
                toolName: "read_file",
                content: [{ type: "text", text: privateOutput }],
                details: { accessToken: "TUI_PRIVATE_TOOL_DETAILS" },
              },
            ],
          }),
        },
      });
      const startTool = vi.spyOn(chatLog, "startTool");

      await loadHistory();

      expect(startTool).toHaveBeenCalledTimes(showsTool ? 1 : 0);
      expect(renderChat(chatLog).includes(privateOutput)).toBe(showsOutput);
    },
  );

  it("restores attachment-only assistant rows from history without exposing references", async () => {
    const loadHistory = mockHistory(
      [
        { role: "assistant", content: [{ type: "image", data: "secret-image" }] },
        {
          role: "assistant",
          content: [{ type: "audio", source: { type: "url", url: "file:///private/audio.mp3" } }],
        },
        { role: "assistant", content: [{ type: "video", url: "file:///private/video.mp4" }] },
        { role: "assistant", content: [{ type: "file", url: "file:///etc/passwd" }] },
      ],
      { sessionId: "session-main" },
    );
    const { loadHistory: runLoadHistory, finalizeAssistant } = createHarness({
      mockChatMethods: ["addSystem", "finalizeAssistant", "clearAll"],
      backend: { describeSession: vi.fn(), loadHistory },
    });

    await runLoadHistory();

    expect(finalizeAssistant.mock.calls.map(([text]) => text)).toEqual([
      "Attached image",
      "Attached audio",
      "Attached video",
      "Attached file",
    ]);
  });

  it.each(["active", "accepted", "concurrent", "superseded"] as const)(
    "settles a delivered %s turn through real history reconciliation",
    async (phase) => {
      const runId = "run-delivered";
      const history = createDeferred<Awaited<ReturnType<TuiBackend["loadHistory"]>>>();
      const h = createHarness({
        mockChatMethods: [],
        backend: { loadHistory: vi.fn(() => history.promise) },
        context: (currentState) => ({
          setActivityStatus: (value) => {
            currentState.activityStatus = value;
          },
        }),
        state: {
          currentSessionId: "session-main",
          activeChatRunId: phase === "active" ? runId : null,
          pendingSubmit: phase === "active" ? null : acceptedSubmit(runId),
          activityStatus: "waiting",
        },
      });
      const { state, chatLog } = h;
      sendPendingUser(state, runId, "question");
      const handlers = h.events();

      handlers.handleSessionsChangedEvent({
        sessionKey: state.currentSessionKey,
        clientRunId: runId,
        runId: "runtime-run",
        phase: "end",
      });
      if (phase === "superseded") {
        state.pendingSubmit = acceptedSubmit("run-new");
      }
      history.resolve({
        sessionInfo: {
          key: state.currentSessionKey,
          sessionId: "session-main",
          activeRunIds: phase === "concurrent" ? ["run-other"] : [],
        },
        ...(phase === "concurrent"
          ? { inFlightRun: { runId: "run-other", text: "Still running" } }
          : {}),
        messages: [
          userMessage("question", "user", 1, { idempotencyKey: `${runId}:user` }),
          assistantMessage("Delivered reply"),
        ],
      });
      await flushImmediate();

      expect(state.activeChatRunId).toBe(phase === "concurrent" ? "run-other" : null);
      expect(getPendingSubmitAcceptedRunId(state)).toBe(phase === "superseded" ? "run-new" : null);
      expect(state.activityStatus).toBe(
        phase === "concurrent" ? "streaming" : phase === "superseded" ? "waiting" : "idle",
      );
      expect(renderChat(chatLog)).toContain("Delivered reply");
      handlers.dispose();
    },
  );

  it.each([
    { persistedRunId: "local-run", pendingRunId: null, pendingUsers: 0, copies: 1 },
    { persistedRunId: "remote-client-run", pendingRunId: "local-run", pendingUsers: 1, copies: 2 },
    { persistedRunId: undefined, pendingRunId: "local-run", pendingUsers: 1, copies: 1 },
  ])(
    "reconciles a pending submit against $persistedRunId history",
    async ({ persistedRunId, pendingRunId, pendingUsers, copies }) => {
      const { state, chatLog, loadHistory } = createHarness({
        chatLog: new ChatLog(40),
        state: {
          currentSessionId: persistedRunId ? "session-main" : null,
          pendingSubmit: acceptedSubmit("local-run", "continue"),
        },
        backend: {
          describeSession: vi.fn(),
          loadHistory: vi.fn().mockResolvedValue({
            sessionId: "session-main",
            ...(persistedRunId ? { sessionInfo: mainSession } : {}),
            messages: persistedRunId
              ? [
                  {
                    role: "user",
                    content: "continue",
                    timestamp: Date.now(),
                    __openclaw: {
                      id: "persisted-pending-user",
                      idempotencyKey: `${persistedRunId}:user`,
                      runId: "execution-run",
                      seq: 1,
                    },
                  },
                ]
              : [],
          }),
        },
      });
      sendPendingUser(state, "local-run", "continue");

      await expect(loadHistory()).resolves.toMatchObject({ loaded: true });

      if (pendingRunId === null) {
        expect(state.pendingSubmit).toBeNull();
      }
      expect(getPendingSubmitAcceptedRunId(state)).toBe(pendingRunId);
      expect(getPendingSubmitDraft(state)).toEqual(
        pendingRunId ? { runId: pendingRunId, text: "continue" } : null,
      );
      expect(chatLog.countPendingUsers()).toBe(pendingUsers);
      expect(renderChat(chatLog).match(/continue/g)).toHaveLength(copies);
    },
  );

  it("uses top-level chat history thinking level when session info inherits it", async () => {
    const describeSession = vi.fn();
    const loadHistory = vi.fn().mockResolvedValue({
      messages: [],
      thinkingLevel: "medium",
      sessionInfo: {
        key: "agent:main:main",
        sessionId: "session-main",
        modelProvider: "openai",
        model: "gpt-5",
        contextTokens: 120_000,
        thinkingDefault: "medium",
        updatedAt: 200,
      },
    });
    const { state, loadHistory: runLoadHistory } = createHarness({
      backend: { describeSession, loadHistory },
    });

    await runLoadHistory();

    expect(describeSession).not.toHaveBeenCalled();
    expect(state.sessionInfo.thinkingLevel).toBe("medium");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

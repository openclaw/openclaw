import { describe, expect, it, onTestFinished, vi } from "vitest";
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
function createHarness(
  stateOverrides: Partial<TuiStateAccess> = {},
  backend: Partial<TuiBackend> = {},
  context: HarnessContext | ((state: TuiStateAccess) => HarnessContext) = {},
  chatLog = new ChatLog(),
) {
  const state = createBaseState(stateOverrides);
  const client = makeTuiBackend(backend);
  const tui = makeTui();
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
const mockDescription = (...args: Parameters<typeof description>) =>
  vi.fn(async () => description(...args));
const activityContext = (state: TuiStateAccess) => ({
  setActivityStatus: (value: string) => {
    state.activityStatus = value;
  },
});
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
const selectedHistory = (
  messages: unknown[] = [],
  sessionId = "session-main",
  info: Record<string, unknown> = {},
) => historyResult(messages, { sessionId, sessionInfo: session(sessionId, info) });
const selectHistoryHarness = (
  messages: unknown[] = [],
  info: Record<string, unknown> = {},
  state: Partial<TuiStateAccess> = {},
) =>
  createHarness(state, {
    describeSession: vi.fn(),
    loadHistory: vi.fn().mockResolvedValue(selectedHistory(messages, "session-main", info)),
  });
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
const researchSelection = {
  currentAgentId: "research",
  currentSessionKey: "agent:research:incident",
};
const researchAgents = [{ id: "research", name: "Research" }];
const opsRoster = (scope: "global" | "per-sender" = "per-sender") => ({
  defaultId: "ops",
  mainKey: "main",
  scope,
  agents: [{ id: "ops" }],
});
const beforeReset = {
  currentSessionId: "session-before-reset",
  sessionGeneration: 4,
  sessionInfo: { model: "model-before-reset", updatedAt: 10 },
};

describe("tui session actions", () => {
  const acceptedSubmit = (
    runId: string,
    draftText: string | null = "pending",
  ): TuiPendingSubmit => ({ phase: "accepted", runId, draftText });
  const persistLiveUser = (state: TuiStateAccess, text: string, id: string) =>
    reduceTuiSessionProjection(state, {
      type: "messagePersisted",
      message: userMessage(text, id, 1),
      scope: readTuiSessionProjectionScope(state),
    });

  const sendPendingUser = (state: TuiStateAccess, runId: string, text: string) =>
    reduceTuiSessionProjection(state, {
      type: "sendPending",
      message: { role: "user", content: text, idempotencyKey: `${runId}:user` },
      runId,
      scope: readTuiSessionProjectionScope(state),
    });

  it.each([
    { owns: true, fails: true },
    { owns: false, fails: true },
    { owns: false, fails: false },
  ])(
    "keeps cached agents on failure or supersession (owns=$owns, fails=$fails)",
    async ({ owns, fails }) => {
      const result = createDeferred<Awaited<ReturnType<TuiBackend["listAgents"]>>>();
      const agentNames = new Map([["research", "Research"]]);
      const cached = {
        ...researchSelection,
        agentDefaultId: "research",
        agents: researchAgents,
        sessionMainKey: "cached-main",
        sessionScope: "per-sender" as const,
      };
      const h = createHarness(cached, { listAgents: vi.fn(() => result.promise) }, { agentNames });
      let current = true;
      const refreshing = h.refreshAgents(() => current);
      current = owns;
      if (fails) {
        result.reject(new Error("gateway unavailable"));
      } else {
        result.resolve(opsRoster());
      }
      await expect(refreshing).resolves.toBe(!fails);
      expect(h.state).toMatchObject(cached);
      expect(h.state.agents).toBe(researchAgents);
      expect([...agentNames]).toEqual([["research", "Research"]]);
      if (owns) {
        expect(h.addSystem).toHaveBeenCalledWith("agents list failed: gateway unavailable");
      } else {
        expect(h.addSystem).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { scope: "global", selection: true },
    { scope: "global", selection: false },
    { scope: "per-sender", selection: false },
  ] as const)(
    "retires the old $scope session on agent change (selection=$selection)",
    async ({ scope, selection }) => {
      const history = createDeferred<unknown>();
      const key = (agent: string) => (scope === "global" ? "global" : `agent:${agent}:main`);
      const h = createHarness(
        {
          currentAgentId: "research",
          currentSessionKey: key("research"),
          currentSessionId: "old",
          agents: researchAgents,
          sessionScope: scope,
          activeChatRunId: "old-run",
          pendingSubmit: acceptedSubmit("pending"),
          historyLoaded: true,
          sessionInfo: {
            model: "private",
            thinkingLevel: "high",
            agentRuntime: { id: "private-runtime", source: "agent" },
            responseUsage: "full",
          },
        },
        {
          loadHistory: vi.fn(() => history.promise),
          listAgents: vi.fn().mockResolvedValue(opsRoster(scope)),
        },
        (state) => ({
          resolveSessionSelection: (_raw, agentId = state.currentAgentId) => ({
            key: key(agentId),
            agentId,
          }),
        }),
      );
      sendPendingUser(h.state, "pending", "private draft");
      h.chatLog.addUser("PRIVATE HISTORY");
      const switching = selection ? h.setSession("", "ops") : h.refreshAgents();
      if (!selection) {
        await expect(switching).resolves.toBe(true);
      }
      expect(h.state).toMatchObject({
        currentAgentId: "ops",
        currentSessionKey: key("ops"),
        currentSessionId: null,
        activeChatRunId: null,
        pendingSubmit: null,
        historyLoaded: false,
      });
      expect(h.state.sessionInfo).toEqual({});
      expect(h.state.sessionProjection?.entries).toEqual([]);
      expect(renderChat(h.chatLog)).not.toContain("PRIVATE HISTORY");
      expect(h.invalidateRunOwnership).toHaveBeenCalledOnce();
      if (!selection) {
        expect(h.client.loadHistory).not.toHaveBeenCalled();
      } else {
        const defaults = { modelProvider: "openai", model: "gpt-5.4", contextTokens: 128_000 };
        history.resolve({ messages: [], sessionInfo: { sessionId: "ops-session" }, defaults });
        await switching;
        expect(h.state.currentSessionId).toBe("ops-session");
        expect(h.state.sessionInfo).toMatchObject(defaults);
        expect([
          h.state.sessionInfo.thinkingLevel,
          h.state.sessionInfo.agentRuntime,
          h.state.sessionInfo.responseUsage,
        ]).toEqual([undefined, undefined, undefined]);
      }
    },
  );

  it("returns success after applying a normalized fresh agent roster", async () => {
    const agentNames = new Map([["cached", "Cached Agent"]]);
    const h = createHarness(
      { agents: [{ id: "cached" }], currentAgentId: "cached" },
      {
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
      (state) => ({
        agentNames,
        resolveSessionSelection: (_raw, agentId = state.currentAgentId) => ({
          key: `agent:${agentId}:${state.sessionMainKey}`,
          agentId,
        }),
      }),
    );
    await expect(h.refreshAgents()).resolves.toBe(true);
    expect(h.state).toMatchObject({
      agentDefaultId: "team-lead",
      sessionMainKey: "primary",
      sessionScope: "per-sender",
      currentAgentId: "team-lead",
      currentSessionKey: "agent:team-lead:primary",
      agents: [
        { id: "team-lead", name: "Lead Agent" },
        { id: "system-agent", kind: "system", name: "System Agent" },
      ],
    });
    expect([...agentNames]).toEqual([
      ["team-lead", "Lead Agent"],
      ["system-agent", "System Agent"],
    ]);
  });

  it("preserves the complete selected session when its agent remains in the roster", async () => {
    const selected = {
      ...researchSelection,
      currentSessionId: "current-session",
      activeChatRunId: "current-run",
      pendingSubmit: acceptedSubmit("pending-run"),
      historyLoaded: true,
      sessionInfo: { thinkingLevel: "high" },
    };
    const h = createHarness(
      { agents: researchAgents, ...selected },
      {
        listAgents: vi.fn().mockResolvedValue({
          ...opsRoster(),
          agents: [{ id: "ops" }, { id: "research" }],
        }),
      },
    );
    sendPendingUser(h.state, "pending-run", "current prompt");
    const projection = h.state.sessionProjection;
    await expect(h.refreshAgents()).resolves.toBe(true);
    expect(h.state).toMatchObject(selected);
    expect(h.state.pendingSubmit).toEqual(acceptedSubmit("pending-run"));
    expect(h.state.sessionProjection).toBe(projection);
    expect(h.invalidateRunOwnership).not.toHaveBeenCalled();
  });

  it("coalesces refresh bursts and applies the latest result", async () => {
    const first = createDeferred<TuiSessionDescription>();
    const last = createDeferred<TuiSessionDescription>();
    const describeSession = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(last.promise);
    const h = createHarness({}, { describeSession });
    const requests = [h.refreshSessionInfo(), h.refreshSessionInfo(), h.refreshSessionInfo()];
    await flushImmediate();
    expect(describeSession).toHaveBeenCalledTimes(1);
    first.resolve(description(session("old", { model: "old" })));
    await flushImmediate();
    expect(describeSession).toHaveBeenCalledTimes(2);
    last.resolve(description(session("current", { model: "current" })));
    await Promise.all(requests);
    expect(describeSession).toHaveBeenCalledTimes(2);
    expect(h.state).toMatchObject({
      currentSessionId: "current",
      sessionInfo: { model: "current" },
    });
    expectCalls(2, h.updateAutocompleteProvider, h.updateFooter, h.requestRender);
    describeSession.mockResolvedValue(
      description(session("current", { model: "current", updatedAt: 200 })),
    );
    await h.refreshSessionInfo();
    expect(h.state.sessionInfo.updatedAt).toBe(200);
    expectCalls(2, h.updateAutocompleteProvider, h.updateFooter, h.requestRender);
  });

  it("keeps the resolved patch projection when a refresh returns an older snapshot", async () => {
    const retained = { fastMode: true, verboseLevel: "full", reasoningLevel: "stream" } as const;
    const h = createHarness(
      {
        sessionInfo: {
          model: "old",
          modelProvider: "ollama",
          updatedAt: 100,
          ...retained,
          traceLevel: "off",
        },
      },
      {
        describeSession: vi
          .fn()
          .mockResolvedValue(
            description(
              session("session-1", { model: "old", modelProvider: "ollama", updatedAt: 100 }),
            ),
          ),
      },
    );
    const resolved = {
      model: "new",
      modelProvider: "openai",
      thinkingLevel: "ultra",
      thinkingLevels: [{ id: "ultra", label: "ultra" }],
      agentRuntime: { id: "openclaw", source: "session-key" },
    } satisfies NonNullable<Awaited<ReturnType<TuiBackend["patchSession"]>>["resolved"]>;
    h.applySessionInfoFromPatch({
      ok: true,
      key: mainSession.key,
      resolved: structuredClone(resolved),
      entry: { model: "raw", modelProvider: "raw", updatedAt: 200, traceLevel: "raw" },
    });
    const expected = { ...resolved, ...retained, updatedAt: 200, traceLevel: "raw" };
    expect(h.state.sessionInfo).toMatchObject(expected);
    await h.refreshSessionInfo();
    expect(h.state.sessionInfo).toMatchObject(expected);
  });

  it.each([
    { selected: "main", result: mainSession.key, accepts: true },
    { selected: "agent:main:current", result: "agent:main:previous", accepts: false },
    { selected: mainSession.key, result: "agent:work:main", accepts: false },
  ])("applies only owned patches: $selected <- $result", ({ selected, result, accepts }) => {
    const h = createHarness({
      currentSessionKey: selected,
      sessionInfo: { model: "current", modelProvider: "openai" },
    });
    h.applySessionInfoFromPatch({ ok: true, key: result, entry: { model: "new" } });
    expect(h.state).toMatchObject({
      currentSessionKey: accepts ? mainSession.key : selected,
      currentAgentId: "main",
      sessionInfo: { model: accepts ? "new" : "current", modelProvider: "openai" },
    });
    if (!accepts) {
      expectCalls(0, h.updateHeader, h.updateFooter);
    }
  });

  it("clears the footer goal when the current session has no row yet", async () => {
    const describeSession = vi.fn().mockResolvedValue({
      defaults: { model: "gpt-5.4", modelProvider: "openai", contextTokens: 272000 },
      session: null,
    });
    const { state, refreshSessionInfo } = createHarness(
      {
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
      { describeSession },
    );

    await refreshSessionInfo();

    expect(state.sessionInfo.goal).toBeUndefined();
    expect(state.sessionInfo).toMatchObject({
      model: "gpt-5.4",
      modelProvider: "openai",
      contextTokens: 272000,
    });
  });

  it.each(["inline", "missing", "hidden"])("reads run metadata from %s rows", async (mode) => {
    const h = createHarness(
      { activeChatRunId: "run-1", currentSessionId: "session-main" },
      { describeSession: vi.fn().mockResolvedValue(description(mainSession)) },
    );
    const events = h.events({
      refreshSessionInfo: h.refreshSessionInfo,
      applySessionEventRow: h.applySessionEventRow,
    });
    onTestFinished(events.dispose);
    events.handleSessionMessageEvent({
      sessionKey: mainSession.key,
      sessionId: "session-main",
      updatedAt: 110,
      message: { role: "toolResult", content: [] },
      ...(mode === "missing"
        ? {}
        : {
            session: session(
              "session-main",
              mode === "hidden" ? { archived: true } : { totalTokens: 1000, contextTokens: 120000 },
            ),
          }),
    });
    if (mode === "inline") {
      await flushImmediate();
      expect(h.client.describeSession).not.toHaveBeenCalled();
      expect(h.state.sessionInfo).toMatchObject({ totalTokens: 1000, contextTokens: 120000 });
    } else {
      await vi.waitFor(() => expect(h.client.describeSession).toHaveBeenCalledOnce());
      await flushImmediate();
      expect(h.client.describeSession).toHaveBeenCalledOnce();
    }
  });

  it.each([false, true])(
    "isolates live users across history replacement (switch=%s)",
    async (switchKey) => {
      const history = createDeferred<unknown>();
      const h = createHarness(
        { currentSessionId: "session-main" },
        { describeSession: vi.fn(), loadHistory: vi.fn(() => history.promise) },
      );
      const key = switchKey ? "agent:main:other" : mainSession.key;
      if (switchKey) {
        persistLiveUser(h.state, "old private prompt", "old-user");
      }
      const loading = switchKey ? h.setSession(key) : h.loadHistory();
      persistLiveUser(h.state, switchKey ? "new prompt" : "old private prompt", "live-user");
      history.resolve(
        selectedHistory([assistantMessage("reply", "reply", 2)], "session-new", { key }),
      );
      await loading;
      const text = renderChat(h.chatLog);
      expect(text).toContain("reply");
      expect(text).not.toContain("old private prompt");
      if (switchKey) {
        expect(text.match(/new prompt/g)).toHaveLength(1);
        expect(text.indexOf("new prompt")).toBeLessThan(text.indexOf("reply"));
      }
    },
  );

  it.each([false, true])("loads older selected metadata with fresh-zero=%s", async (fresh) => {
    const next = {
      key: "agent:main:other",
      model: "selected",
      modelProvider: "openai",
      updatedAt: 50,
      thinkingDefault: "medium",
      contextTokens: 120_000,
      ...(fresh ? { totalTokensFresh: true } : {}),
    };
    const h = createHarness(
      {
        historyLoaded: true,
        sessionInfo: {
          model: "previous",
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          updatedAt: 500,
        },
      },
      {
        describeSession: vi.fn(),
        loadHistory: mockHistory([], {
          ...selectedHistory([], "session-2", next),
          thinkingLevel: "medium",
        }),
      },
    );
    await h.setSession(next.key);
    expect(h.state).toMatchObject({
      currentSessionKey: next.key,
      currentSessionId: "session-2",
      sessionInfo: {
        model: "selected",
        modelProvider: "openai",
        updatedAt: 50,
        thinkingLevel: "medium",
        contextTokens: 120_000,
        inputTokens: null,
        outputTokens: null,
        totalTokens: fresh ? 0 : null,
      },
    });
    if (fresh) {
      expect(h.state.sessionInfo.totalTokensFresh).toBe(true);
    }
    expect(h.client.describeSession).not.toHaveBeenCalled();
    expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
    expect(h.btw.clear).toHaveBeenCalled();
  });

  it.each([
    { membership: ["run-next"], expected: ["run-next"] },
    { membership: ["run-previous", "run-next"], expected: ["run-previous", "run-next"] },
    { membership: undefined, expected: undefined },
    { membership: ["run-next", 42], expected: undefined },
  ])(
    "exports validated active history membership: $membership",
    async ({ membership, expected }) => {
      const h = selectHistoryHarness([], { activeRunIds: membership });
      h.client.loadHistory = mockHistory([], {
        ...selectedHistory([], "session-main", { activeRunIds: membership }),
        inFlightRun: { runId: "run-next", text: "new partial" },
      });
      await expect(h.loadHistory()).resolves.toEqual({
        loaded: true,
        runOutcome: { state: "active", runId: "run-next" },
        ...(expected ? { activeRunIds: expected } : {}),
      });
      expect(h.state.activeChatRunId).toBe("run-next");
      expect(renderChat(h.chatLog)).toContain("new partial");
    },
  );

  it.each(["agent:main:main", "main"])(
    "preserves current run ownership on reselecting %s",
    async (key) => {
      const selected = {
        activeChatRunId: "run-active",
        pendingSubmit: acceptedSubmit("pending", "prompt"),
        activityStatus: "streaming",
        historyLoaded: true,
      };
      const h = createHarness(selected, {}, activityContext);
      sendPendingUser(h.state, "pending", "prompt");
      h.chatLog.addPendingUser("pending", "prompt");
      await h.setSession(key);
      expect(h.state).toMatchObject(selected);
      expect(h.state.pendingSubmit).toEqual(selected.pendingSubmit);
      expect(renderChat(h.chatLog)).toContain("prompt");
      expectCalls(0, h.invalidateRunOwnership, h.clearLocalRunIds, h.client.loadHistory);
    },
  );

  it("reloads missing initial history and remembers its canonical key", async () => {
    const h = createHarness(
      { currentSessionKey: "main", historyLoaded: false },
      {
        loadHistory: mockHistory([], { sessionId: "session-main" }),
        describeSession: mockDescription(mainSession),
      },
    );
    await h.setSession("main");
    expect(h.client.loadHistory).toHaveBeenCalledOnce();
    expect(h.state).toMatchObject({
      historyLoaded: true,
      currentSessionKey: mainSession.key,
      currentSessionId: "session-main",
    });
    expect(h.rememberSessionKey).toHaveBeenCalledWith(mainSession.key);
  });

  it("adopts an in-flight run without buffered text", async () => {
    const h = createHarness(
      { currentSessionKey: "agent:main:other" },
      {
        describeSession: vi.fn(),
        loadHistory: mockHistory([], {
          sessionId: "session-bg",
          inFlightRun: { runId: "run-bg", text: "" },
        }),
      },
    );
    await h.setSession(mainSession.key);
    expect(h.updateAssistant).not.toHaveBeenCalled();
    expect(h.state.activeChatRunId).toBe("run-bg");
    expect(h.setActivityStatus).toHaveBeenLastCalledWith("streaming");
  });

  it.each(["history success", "history failure", "description success", "ABA"] as const)(
    "ignores superseded selection during %s",
    async (outcome) => {
      const oldHistory = createDeferred<unknown>();
      const oldInfo = createDeferred<TuiSessionDescription>();
      const nextHistory = createDeferred<unknown>();
      const nextInfo = createDeferred<TuiSessionDescription>();
      const describes = outcome === "description success" || outcome === "ABA";
      const describeSession = vi.fn();
      if (describes) {
        describeSession.mockReturnValueOnce(oldInfo.promise).mockReturnValueOnce(nextInfo.promise);
      }
      const loadHistory = vi
        .fn()
        .mockReturnValueOnce(oldHistory.promise)
        .mockReturnValueOnce(nextHistory.promise);
      if (outcome === "ABA") {
        loadHistory.mockResolvedValueOnce(
          selectedHistory([], "session-a-new", { key: "agent:main:A", model: "new" }),
        );
      }
      const h = createHarness(
        { currentSessionKey: "agent:main:home" },
        {
          describeSession,
          loadHistory,
        },
      );
      const first = h.setSession("agent:main:A");
      if (describes) {
        oldHistory.resolve(
          historyResult([{ role: "user", content: "message from A" }], { sessionId: "old" }),
        );
        await vi.waitFor(() => expect(describeSession).toHaveBeenCalledOnce());
      }
      const second = h.setSession("agent:main:B");
      nextHistory.resolve(
        describes && outcome !== "ABA"
          ? historyResult([{ role: "user", content: "message from B" }], { sessionId: "session-b" })
          : switchHistory("B"),
      );
      if (outcome === "ABA") {
        await second;
        await h.setSession("agent:main:A");
      }
      if (outcome === "description success") {
        oldInfo.resolve(description(switchSession("A")));
        await vi.waitFor(() => expect(describeSession).toHaveBeenCalledTimes(2));
        nextInfo.resolve(description(switchSession("B")));
      } else if (outcome === "ABA") {
        oldInfo.resolve(description({ ...switchSession("A"), model: "old" }));
      } else if (outcome === "history failure") {
        oldHistory.reject(new Error("history failed"));
      } else {
        oldHistory.resolve(switchHistory("A", { inFlightRun: { runId: "stale", text: "stale" } }));
      }
      await Promise.all([first, second]);
      expect(h.state).toMatchObject(
        outcome === "ABA"
          ? {
              currentSessionKey: "agent:main:A",
              currentSessionId: "session-a-new",
              sessionInfo: { model: "new" },
            }
          : {
              currentSessionKey: "agent:main:B",
              currentSessionId: "session-b",
              activeChatRunId: null,
            },
      );
      expect(h.addUser.mock.calls.map(([text]) => text)).not.toContain("message from A");
      expect(h.addUser.mock.calls.map(([text]) => text)).toContain("message from B");
      expect(h.addSystem.mock.calls.map(([text]) => text).join("\n")).not.toMatch(
        /history failed|description failed/,
      );
    },
  );

  it.each([true, false])("only renders genuine history errors (abort=%s)", async (abort) => {
    const error = abort
      ? new DOMException("stopped", "AbortError")
      : new Error("gateway unavailable");
    const h = createHarness({}, { loadHistory: vi.fn().mockRejectedValue(error) });
    await expect(h.loadHistory()).resolves.toEqual({ loaded: false });
    expect(h.addSystem.mock.calls).toEqual(abort ? [] : [["history failed: gateway unavailable"]]);
    expect(h.requestRender.mock.calls).toEqual(abort ? [] : [[true]]);
  });

  it("adopts a reset mutation's replacement key without reloading gateway history", () => {
    const h = createHarness({
      currentSessionKey: "old",
      currentSessionId: "old-session",
      sessionInfo: { model: "old" },
    });
    const entry = {
      sessionId: "new-session",
      model: "new-model",
      modelProvider: "openai",
      updatedAt: 123,
    };
    expect(h.applySessionMutationResult({ ok: true, key: "agent:main:new", entry })).toBe(true);
    expect(h.client.loadHistory).not.toHaveBeenCalled();
    expect(h.state).toMatchObject({
      currentSessionKey: "agent:main:new",
      currentSessionId: "new-session",
      sessionInfo: { model: "new-model", modelProvider: "openai", updatedAt: 123 },
      historyLoaded: true,
    });
    expect(h.clearAll).toHaveBeenCalled();
    expect(h.addSystem).toHaveBeenCalledWith("session agent:main:new");
  });

  it.each(["none", "before adoption", "during refresh", "after acknowledgement"])(
    "keeps the reset acknowledgement with a notification %s",
    async (notification) => {
      const entry = { sessionId: "same-session", updatedAt: 20, totalTokens: 0 };
      const result = { ok: true, key: mainSession.key, entry };
      const refreshStarted = createDeferred();
      const refreshResult = createDeferred<TuiSessionDescription>();
      const resetResponse = createDeferred<typeof result>();
      const h = createHarness(
        {
          currentSessionId: "same-session",
          sessionGeneration: 4,
          historyLoaded: true,
          sessionInfo: { updatedAt: 10, totalTokens: 42 },
        },
        {
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
      );
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

  it.each([
    { source: "local", fails: false },
    { source: "external", fails: false },
    { source: "external", fails: true },
  ])(
    "fences pre-reset history and description ($source, error=$fails)",
    async ({ source, fails }) => {
      const history = createDeferred<unknown>();
      const info = createDeferred<TuiSessionDescription>();
      const h = createHarness(
        {
          ...beforeReset,
          sessionInfo: {
            model: "model-before-reset",
            ...(source === "local" ? { updatedAt: 10 } : {}),
          },
        },
        {
          loadHistory: vi.fn(() => history.promise),
          describeSession: vi.fn(() => info.promise),
        },
      );
      const staleHistory = h.loadHistory();
      const staleInfo = h.refreshSessionInfo();
      await vi.waitFor(() => expect(h.client.describeSession).toHaveBeenCalledOnce());
      const replacement = {
        sessionId: "session-after-reset",
        model: "model-after-reset",
        updatedAt: 20,
      };
      if (source === "local") {
        expect(
          h.applySessionMutationResult({ ok: true, key: mainSession.key, entry: replacement }),
        ).toBe(true);
      } else {
        Object.assign(h.state, {
          sessionGeneration: 5,
          currentSessionId: replacement.sessionId,
          sessionInfo: { model: replacement.model },
        });
      }
      history.resolve(
        selectedHistory([{ role: "user", content: "before reset" }], beforeReset.currentSessionId, {
          model: "stale-history-model",
        }),
      );
      if (fails) {
        info.reject(new Error("private previous-session details"));
      } else {
        info.resolve(
          description(
            session(beforeReset.currentSessionId, {
              model: "stale-session-info-model",
              updatedAt: 10,
            }),
          ),
        );
      }
      await expect(staleHistory).resolves.toEqual({ loaded: false });
      await staleInfo;
      expect(h.state).toMatchObject({
        sessionGeneration: 5,
        currentSessionId: replacement.sessionId,
        sessionInfo: { model: replacement.model },
      });
      expect(h.addUser).not.toHaveBeenCalled();
      expect(h.clearAll).toHaveBeenCalledTimes(source === "local" ? 1 : 0);
      if (source === "external") {
        expect(h.addSystem).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["foreign", "missing"] as const)("does not apply a %s reset result", (reason) => {
    const selected = {
      currentSessionId: "current",
      historyLoaded: reason !== "missing",
      sessionInfo: { model: "current" },
    };
    const h = createHarness(selected);
    const foreign = reason === "foreign";
    expect(
      h.applySessionMutationResult(
        foreign
          ? { ok: true, key: "agent:main:previous", entry: { model: "stale" } }
          : { ok: true },
        foreign ? { sessionKey: "agent:main:previous", agentId: "main" } : undefined,
      ),
    ).toBe(false);
    expect(h.state).toMatchObject({ ...selected, currentSessionKey: mainSession.key });
    expectCalls(0, h.clearAll, h.addSystem, h.updateHeader);
  });

  it.each([
    ["interrupted", { status: "killed", abortedLastRun: true }, { state: "interrupted" }],
    [
      "failed",
      { status: "failed", lastRunError: "provider failed" },
      { state: "failed", errorMessage: "provider failed" },
    ],
  ] as const)("projects a closed %s history outcome", async (_name, sessionInfo, runOutcome) => {
    const { loadHistory } = createHarness(
      {},
      {
        describeSession: vi.fn(),
        loadHistory: mockHistory([], { sessionId: "session-main", sessionInfo }),
      },
    );

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
      const { chatLog, loadHistory } = selectHistoryHarness(
        [
          {
            role: "toolResult",
            toolCallId: "tool-private",
            toolName: "read_file",
            content: [{ type: "text", text: privateOutput }],
            details: { accessToken: "TUI_PRIVATE_TOOL_DETAILS" },
          },
        ],
        { verboseLevel },
        { sessionInfo: { verboseLevel } },
      );
      const startTool = vi.spyOn(chatLog, "startTool");

      await loadHistory();

      expect(startTool).toHaveBeenCalledTimes(showsTool ? 1 : 0);
      expect(renderChat(chatLog).includes(privateOutput)).toBe(showsOutput);
    },
  );

  it("restores attachment-only assistant rows from history without exposing references", async () => {
    const h = selectHistoryHarness([
      {
        role: "assistant",
        content: [
          { type: "image", data: "secret-image" },
          { type: "audio", source: { type: "url", url: "file:///private/audio.mp3" } },
          { type: "video", url: "file:///private/video.mp4" },
          { type: "file", url: "file:///etc/passwd" },
        ],
      },
    ]);
    await h.loadHistory();
    const rendered = renderChat(h.chatLog);
    for (const kind of ["image", "audio", "video", "file"]) {
      expect(rendered).toContain("Attached " + kind);
    }
    expect(rendered).not.toMatch(/secret-image|file:\/\/|private|passwd/);
  });

  it.each(["active", "accepted", "concurrent", "superseded"] as const)(
    "settles a delivered %s turn through real history reconciliation",
    async (phase) => {
      const runId = "run-delivered";
      const history = createDeferred<Awaited<ReturnType<TuiBackend["loadHistory"]>>>();
      const h = createHarness(
        {
          currentSessionId: "session-main",
          activeChatRunId: phase === "active" ? runId : null,
          pendingSubmit: phase === "active" ? null : acceptedSubmit(runId),
          activityStatus: "waiting",
        },
        { loadHistory: vi.fn(() => history.promise) },
        activityContext,
      );
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
      const { state, chatLog, loadHistory } = createHarness(
        {
          currentSessionId: persistedRunId ? "session-main" : null,
          pendingSubmit: acceptedSubmit("local-run", "continue"),
        },
        {
          describeSession: vi.fn(),
          loadHistory: vi.fn().mockResolvedValue({
            sessionId: "session-main",
            ...(persistedRunId ? { sessionInfo: mainSession } : {}),
            messages: persistedRunId
              ? [
                  userMessage("continue", "persisted-pending-user", 1, {
                    idempotencyKey: `${persistedRunId}:user`,
                    runId: "execution-run",
                  }),
                ]
              : [],
          }),
        },
        {},
        new ChatLog(40),
      );
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
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

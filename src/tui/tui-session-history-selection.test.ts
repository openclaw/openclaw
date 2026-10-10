import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { TuiBackend } from "./tui-backend.js";
import { createTuiCommandHandlersHarness } from "./tui-command-handlers-test-support.js";
import {
  createBaseState,
  createTestSessionActions,
  makeTuiBackend,
} from "./tui-session-actions-test-support.js";
import { createEditorSubmitHandler, createSubmitBurstCoalescer } from "./tui-submit.js";

const key = "agent:research:global";
const stateFor = () => createBaseState({ currentAgentId: "research", currentSessionKey: key });

it.each([
  { previous: "global", next: key },
  { previous: key, next: "global" },
])(
  "rejects an old setting result while changing $previous to $next",
  async ({ previous, next }) => {
    const reply = {
      ok: true,
      path: "test",
      key: previous,
      entry: { verboseLevel: "full" },
    } as const;
    const patch = createDeferred<typeof reply>();
    const patchEntered = createDeferred();
    const history = createDeferred<unknown>();
    const historyEntered = createDeferred();
    const loadHistory = vi.fn(async () => {
      historyEntered.resolve();
      return history.promise;
    });
    const commands = createTuiCommandHandlersHarness({
      currentAgentId: "research",
      currentSessionKey: previous,
      currentSessionId: null,
      patchSession: vi.fn(() => {
        patchEntered.resolve();
        return patch.promise;
      }),
      applySessionInfoFromPatch: vi.fn((result) => actions.applySessionInfoFromPatch(result)),
    });
    const state = Object.assign(
      commands.state,
      createBaseState({
        currentAgentId: "research",
        currentSessionKey: previous,
        historyLoaded: true,
      }),
    );
    const actions = createTestSessionActions({
      state,
      client: makeTuiBackend({ loadHistory }),
      resolveSessionSelection: (raw = "global") => ({ key: raw, agentId: "research" }),
    });
    const pending = commands.handleCommand("/verbose full");
    await patchEntered.promise;
    const selecting = actions.setSession(next);
    await historyEntered.promise;
    try {
      patch.resolve(reply);
      await pending;
      expect(state.currentSessionKey).toBe(next);
      expect(state.sessionInfo.verboseLevel).not.toBe("full");
      expect(commands.addSystem).not.toHaveBeenCalled();
    } finally {
      patch.resolve(reply);
      history.resolve({
        messages: [],
        sessionId: "selected-row",
        sessionInfo: { key: next, sessionId: "selected-row" },
      });
      await Promise.all([pending, selecting]);
    }
    expect(state.currentSessionKey).toBe(next);
    expect(state.currentSessionId).toBe("selected-row");
    expect(loadHistory).toHaveBeenCalledOnce();
  },
);

it.each(["agent:research:main", "global"])(
  "resolves the missing qualified-global alias to Home %s",
  async (homeKey) => {
    const state = stateFor();
    const loadHistory = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: [], sessionId: "legacy-home" });
    const actions = createTestSessionActions({
      state,
      client: makeTuiBackend({
        loadHistory,
        describeSession: async () => ({ session: { key: homeKey, sessionId: "legacy-home" } }),
      }),
      resolveSessionSelection: (raw, agentId) => ({
        key: raw ?? homeKey,
        agentId: agentId ?? "research",
      }),
    });
    await expect(actions.loadHistory()).resolves.toMatchObject({ loaded: true });
    expect(loadHistory).toHaveBeenNthCalledWith(2, {
      sessionKey: homeKey,
      agentId: "research",
      limit: 200,
    });
    expect(state.currentSessionKey).toBe(homeKey);
    expect(state.currentSessionId).toBe("legacy-home");
  },
);

it.each([
  { name: "empty existing row", history: { messages: [], sessionId: "literal-row" } },
  {
    name: "nested existing identity",
    history: { messages: [], sessionInfo: { sessionId: "literal-row" } },
  },
  {
    name: "archived row",
    history: { messages: [], sessionId: "literal-row", sessionInfo: { archived: true } },
  },
  {
    name: "identity-free nonempty history",
    history: { messages: [{ role: "assistant", content: "Retained history" }] },
  },
  { name: "partial reply", history: {} },
  { name: "malformed metadata", history: { messages: [], sessionInfo: "incomplete" } },
])("does not reinterpret $name as a missing qualified row", async ({ history }) => {
  const state = stateFor();
  const loadHistory = vi.fn(async () => history);
  const actions = createTestSessionActions({ state, client: makeTuiBackend({ loadHistory }) });
  await actions.loadHistory();
  expect(state.currentSessionKey).toBe(key);
  expect(loadHistory).toHaveBeenCalledOnce();
});

it("does not adopt Home after another session is selected during the legacy lookup", async () => {
  const entered = createDeferred();
  const held = createDeferred<unknown>();
  const state = stateFor();
  const loadHistory = vi.fn(async ({ sessionKey }: { sessionKey: string }) => {
    if (sessionKey === key) {
      return { messages: [] };
    }
    if (sessionKey === "global") {
      entered.resolve();
      return held.promise;
    }
    return { messages: [], sessionId: "new-choice", sessionInfo: { key: sessionKey } };
  });
  const actions = createTestSessionActions({
    state,
    client: makeTuiBackend({ loadHistory }),
    resolveSessionSelection: (raw = "global") => ({ key: raw, agentId: "research" }),
  });
  const pending = actions.loadHistory();
  try {
    await entered.promise;
    await actions.setSession("agent:research:notes");
  } finally {
    held.resolve({ messages: [], sessionId: "late-home" });
  }
  await expect(pending).resolves.toEqual({ loaded: false });
  expect(state.currentSessionKey).toBe("agent:research:notes");
  expect(state.currentSessionId).toBe("new-choice");
});

it.each(
  ["global", key].flatMap((storedKey) => [
    { storedKey, coalesced: false },
    { storedKey, coalesced: true },
  ]),
)(
  "keeps a submit editable until selection resolves to $storedKey (coalesced=$coalesced)",
  async ({ storedKey, coalesced }) => {
    const entered = createDeferred();
    const exact = createDeferred<unknown>();
    const pendingCommands: Promise<void>[] = [];
    const pendingMessages: Promise<void>[] = [];
    const sendChat = vi.fn(async (_params: Parameters<TuiBackend["sendChat"]>[0]) => ({
      runId: "submitted",
      status: "accepted",
    }));
    const commands = createTuiCommandHandlersHarness({
      currentAgentId: "research",
      currentSessionKey: "agent:research:notes",
      sendChat,
      setSession: vi.fn((raw, agentId) => actions.setSession(raw, agentId)),
    });
    const state = Object.assign(
      commands.state,
      createBaseState({
        currentAgentId: "research",
        currentSessionKey: "agent:research:notes",
        historyLoaded: true,
        isConnected: true,
      }),
    );
    const actions = createTestSessionActions({
      state,
      client: makeTuiBackend({
        loadHistory: async ({ sessionKey }) => {
          if (sessionKey === key) {
            entered.resolve();
            return exact.promise;
          }
          return {
            messages: [],
            sessionId: "selected-conversation",
            sessionInfo: { key: "global", sessionId: "selected-conversation" },
          };
        },
      }),
      resolveSessionSelection: (raw = "global") => ({ key: raw, agentId: "research" }),
    });
    let editorText = "";
    const addToHistory = vi.fn();
    const submit = createEditorSubmitHandler({
      editor: {
        getText: () => editorText,
        getExpandedText: () => editorText,
        setText: (text) => {
          editorText = text;
        },
        addToHistory,
      },
      handleCommand: (text) => {
        const work = commands.handleCommand(text);
        pendingCommands.push(work);
        return work;
      },
      sendMessage: (text) => {
        const work = commands.sendMessage(text);
        pendingMessages.push(work);
        return work;
      },
      handleBangLine: vi.fn(),
      onSubmitError: vi.fn(),
      admitMessage: commands.resolveMessageAdmission,
      onBlockedMessageSubmit: commands.reportBlockedMessageSubmit,
    });
    const releaseExact = () =>
      exact.resolve(
        storedKey === key
          ? {
              messages: [],
              sessionId: "selected-conversation",
              sessionInfo: { key, sessionId: "selected-conversation" },
            }
          : { messages: [] },
      );
    if (coalesced) {
      vi.useFakeTimers();
    }
    const bufferedSubmit = createSubmitBurstCoalescer({
      submit,
      captureSnapshot: commands.captureMessageAdmission,
      enabled: true,
      burstWindowMs: 50,
    });
    submit(`/session ${key}`);
    await entered.promise;
    try {
      if (coalesced) {
        bufferedSubmit("Immediate message");
        releaseExact();
        await Promise.all(pendingCommands);
        vi.advanceTimersByTime(50);
      } else {
        submit("Immediate message");
      }
      expect(sendChat).not.toHaveBeenCalled();
      expect(editorText).toBe("Immediate message");
      expect(addToHistory).not.toHaveBeenCalledWith("Immediate message");
      releaseExact();
      await Promise.all(pendingCommands);
      editorText = "";
      submit("Immediate message");
      await Promise.all(pendingMessages);
      expect(sendChat).toHaveBeenCalledOnce();
      expect(sendChat.mock.calls[0]?.[0]).toMatchObject({
        sessionKey: storedKey,
        sessionId: "selected-conversation",
        message: "Immediate message",
        ...(storedKey === "global" ? { agentId: "research" } : {}),
      });
    } finally {
      exact.resolve({ messages: [] });
      bufferedSubmit.dispose();
      vi.useRealTimers();
      await Promise.all([...pendingCommands, ...pendingMessages]);
    }
  },
);

it.each([
  { command: "/verbose full", backend: "patchSession" },
  { command: "/btw side question", backend: "sendChat" },
  { command: "/new", backend: "createSession" },
  { command: "/reset", backend: "resetSession" },
  { command: "/goal set finish the task", backend: "runGoalCommand" },
  { command: "/usage cost", backend: "runUsageCostCommand" },
  { command: "Escape", backend: "abortChat" },
] as const)(
  "rejects $command while selected history is unresolved",
  async ({ command, backend }) => {
    const commands = createTuiCommandHandlersHarness({
      currentAgentId: "research",
      currentSessionKey: key,
      historyLoaded: false,
      opts: { local: true },
    });
    if (backend === "abortChat") {
      const abortChat = vi.fn(async () => ({ ok: true, aborted: false, runIds: [] }));
      const actions = createTestSessionActions({
        state: stateFor(),
        client: makeTuiBackend({ abortChat }),
      });
      await actions.abortActive({ preferActive: true });
      expect(abortChat).not.toHaveBeenCalled();
    } else {
      await commands.handleCommand(command);
      expect(commands.client[backend]).not.toHaveBeenCalled();
      expect(commands.addSystem).toHaveBeenCalledWith(
        "session history not ready — wait or retry /session",
      );
    }
  },
);

it("keeps a failed selection blocked and lets /session retry it", async () => {
  const commands = createTuiCommandHandlersHarness({
    currentAgentId: "research",
    currentSessionKey: key,
    setSession: vi.fn((raw, agentId) => actions.setSession(raw, agentId)),
  });
  const state = Object.assign(commands.state, stateFor());
  const loadHistory = vi
    .fn()
    .mockRejectedValueOnce(new Error("history unavailable"))
    .mockResolvedValueOnce({
      messages: [],
      sessionId: "selected",
      sessionInfo: { key, sessionId: "selected" },
    });
  const actions = createTestSessionActions({
    state,
    client: makeTuiBackend({ loadHistory }),
    resolveSessionSelection: (raw = key) => ({ key: raw, agentId: "research" }),
  });
  await expect(actions.loadHistory()).resolves.toEqual({ loaded: false });
  expect(state.currentSessionKey).toBe(key);
  expect(loadHistory).toHaveBeenCalledOnce();
  await commands.sendMessage("do not send after failed history");
  expect(commands.sendChat).not.toHaveBeenCalled();
  expect(state.historyLoaded).toBe(false);
  await commands.handleCommand(`/session ${key}`);
  await commands.sendMessage("send after retry");
  expect(commands.sendChat).toHaveBeenCalledOnce();
  expect(state.historyLoaded).toBe(true);
});

it("does not block a resolved conversation during an ordinary history refresh", async () => {
  const history = createDeferred<unknown>();
  const commands = createTuiCommandHandlersHarness({
    currentAgentId: "research",
    currentSessionKey: key,
  });
  const state = Object.assign(
    commands.state,
    createBaseState({
      currentAgentId: "research",
      currentSessionKey: key,
      currentSessionId: "selected",
      historyLoaded: true,
    }),
  );
  const actions = createTestSessionActions({
    state,
    client: makeTuiBackend({ loadHistory: () => history.promise }),
  });
  const refreshing = actions.loadHistory();
  try {
    await commands.sendMessage("send during refresh");
    expect(commands.sendChat).toHaveBeenCalledOnce();
  } finally {
    history.resolve({
      messages: [],
      sessionId: "selected",
      sessionInfo: { key, sessionId: "selected" },
    });
    await refreshing;
  }
});

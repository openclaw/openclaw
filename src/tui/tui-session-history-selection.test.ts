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
const select = (raw = "global", agentId = "research") => ({ key: raw, agentId });
const selectedHistory = (sessionKey: string, sessionId: string) => ({
  messages: [],
  sessionId,
  sessionInfo: { key: sessionKey, sessionId },
});

function heldCall<T = unknown>() {
  const result = createDeferred<T>();
  const entered = createDeferred();
  return {
    ...result,
    entered: entered.promise,
    call: vi.fn(() => {
      entered.resolve();
      return result.promise;
    }),
  };
}

function selectionHarness(
  commandOptions: Parameters<typeof createTuiCommandHandlersHarness>[0] = {},
  backend: Partial<TuiBackend> = {},
  resolveSessionSelection = select,
) {
  const commands = createTuiCommandHandlersHarness({
    currentAgentId: "research",
    currentSessionKey: key,
    setSession: vi.fn((raw, agentId) => actions.setSession(raw, agentId)),
    applySessionInfoFromPatch: vi.fn((result) => actions.applySessionInfoFromPatch(result)),
    ...commandOptions,
  });
  const state = Object.assign(commands.state, createBaseState(commands.state));
  const sessionClient = makeTuiBackend(backend);
  const actions = createTestSessionActions({
    state,
    client: sessionClient,
    resolveSessionSelection,
  });
  return { ...commands, state, actions, sessionClient };
}

it.each([
  ["global", key],
  [key, "global"],
])("rejects old setting results during %s → %s selection", async (previous, next) => {
  const reply = { key: previous, entry: { verboseLevel: "full" } } as const;
  const patch = heldCall<typeof reply>();
  const history = heldCall();
  const { state, actions, handleCommand, addSystem } = selectionHarness(
    { currentSessionKey: previous, patchSession: patch.call },
    { loadHistory: history.call },
  );
  const pending = handleCommand("/verbose full");
  await patch.entered;
  const selecting = actions.setSession(next);
  await history.entered;
  try {
    patch.resolve(reply);
    await pending;
    expect(state.currentSessionKey).toBe(next);
    expect(state.sessionInfo.verboseLevel).not.toBe("full");
    expect(addSystem).not.toHaveBeenCalled();
  } finally {
    history.resolve(selectedHistory(next, "selected-row"));
    await Promise.all([pending, selecting]);
  }
  expect(state).toMatchObject({ currentSessionKey: next, currentSessionId: "selected-row" });
  expect(history.call).toHaveBeenCalledOnce();
});

it.each(["agent:research:main", "global"])(
  "resolves the missing qualified-global alias to Home %s",
  async (homeKey) => {
    const loadHistory = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: [], sessionId: "legacy-home" });
    const { state, actions } = selectionHarness(
      { historyLoaded: false },
      {
        loadHistory,
        describeSession: async () => ({ session: { key: homeKey, sessionId: "legacy-home" } }),
      },
      (raw, agentId) => select(raw ?? homeKey, agentId),
    );
    await expect(actions.loadHistory()).resolves.toMatchObject({ loaded: true });
    expect(loadHistory).toHaveBeenNthCalledWith(2, {
      sessionKey: homeKey,
      agentId: "research",
      limit: 200,
    });
    expect(state).toMatchObject({ currentSessionKey: homeKey, currentSessionId: "legacy-home" });
  },
);

it.each([
  ["empty existing row", { messages: [], sessionId: "literal-row" }],
  ["nested existing identity", { messages: [], sessionInfo: { sessionId: "literal-row" } }],
  ["identity-free nonempty history", { messages: [{ role: "assistant", content: "x" }] }],
  ["partial reply", {}],
  ["malformed metadata", { messages: [], sessionInfo: "incomplete" }],
] as const)("does not reinterpret %s as a missing qualified row", async (_name, history) => {
  const loadHistory = vi.fn(async () => history);
  const { state, actions } = selectionHarness({ historyLoaded: false }, { loadHistory });
  await actions.loadHistory();
  expect(state.currentSessionKey).toBe(key);
  expect(loadHistory).toHaveBeenCalledOnce();
});

it("does not adopt Home after another session is selected during the legacy lookup", async () => {
  const held = heldCall();
  const loadHistory = vi.fn(async ({ sessionKey }: { sessionKey: string }) =>
    sessionKey === key
      ? { messages: [] }
      : sessionKey === "global"
        ? held.call()
        : { messages: [], sessionId: "new-choice", sessionInfo: { key: sessionKey } },
  );
  const { state, actions } = selectionHarness({ historyLoaded: false }, { loadHistory });
  const pending = actions.loadHistory();
  try {
    await held.entered;
    await actions.setSession("agent:research:notes");
  } finally {
    held.resolve({ messages: [], sessionId: "late-home" });
  }
  await expect(pending).resolves.toEqual({ loaded: false });
  expect(state).toMatchObject({
    currentSessionKey: "agent:research:notes",
    currentSessionId: "new-choice",
  });
});

it.each([
  ["global", false],
  ["global", true],
  [key, false],
  [key, true],
] as const)(
  "keeps a submit editable until selection resolves to %s (coalesced=%s)",
  async (storedKey, coalesced) => {
    const exact = heldCall();
    const sessionId = "selected-conversation";
    const pending: Promise<void>[] = [];
    const sendChat = vi.fn<TuiBackend["sendChat"]>(async () => ({
      runId: "submitted",
      status: "accepted",
    }));
    const commands = selectionHarness(
      { currentSessionKey: "agent:research:notes", sendChat },
      {
        loadHistory: async ({ sessionKey }) =>
          sessionKey === key ? exact.call() : selectedHistory("global", sessionId),
      },
    );
    let editorText = "";
    const addToHistory = vi.fn();
    const track = (work: Promise<void>) => {
      pending.push(work);
      return work;
    };
    const submit = createEditorSubmitHandler({
      editor: {
        getText: () => editorText,
        getExpandedText: () => editorText,
        setText: (text) => {
          editorText = text;
        },
        addToHistory,
      },
      handleCommand: (text) => track(commands.handleCommand(text)),
      sendMessage: (text) => track(commands.sendMessage(text)),
      handleBangLine: vi.fn(),
      onSubmitError: vi.fn(),
      admitMessage: commands.resolveMessageAdmission,
      onBlockedMessageSubmit: commands.reportBlockedMessageSubmit,
    });
    const releaseExact = () =>
      exact.resolve(storedKey === key ? selectedHistory(key, sessionId) : { messages: [] });
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
    await exact.entered;
    try {
      if (coalesced) {
        bufferedSubmit("Immediate message");
        releaseExact();
        await Promise.all(pending);
        vi.advanceTimersByTime(50);
      } else {
        submit("Immediate message");
      }
      expect(sendChat).not.toHaveBeenCalled();
      expect(editorText).toBe("Immediate message");
      expect(addToHistory).not.toHaveBeenCalledWith("Immediate message");
      releaseExact();
      await Promise.all(pending);
      editorText = "";
      submit("Immediate message");
      await Promise.all(pending);
      expect(sendChat).toHaveBeenCalledOnce();
      expect(sendChat.mock.calls[0]?.[0]).toMatchObject({
        sessionKey: storedKey,
        sessionId,
        message: "Immediate message",
        ...(storedKey === "global" ? { agentId: "research" } : {}),
      });
    } finally {
      exact.resolve({ messages: [] });
      bufferedSubmit.dispose();
      vi.useRealTimers();
      await Promise.all(pending);
    }
  },
);

it.each([
  ["/verbose full", "patchSession"],
  ["/btw side question", "sendChat"],
  ["/new", "createSession"],
  ["/reset", "resetSession"],
  ["/goal set finish the task", "runGoalCommand"],
  ["/usage cost", "runUsageCostCommand"],
  ["Escape", "abortChat"],
] as const)("blocks %s until history resolves", async (command, backend) => {
  const commands = selectionHarness({ historyLoaded: false, opts: { local: true } });
  if (backend === "abortChat") {
    await commands.actions.abortActive({ preferActive: true });
    expect(commands.sessionClient.abortChat).not.toHaveBeenCalled();
  } else {
    await commands.handleCommand(command);
    expect(commands.client[backend]).not.toHaveBeenCalled();
    expect(commands.addSystem).toHaveBeenCalledWith(
      "session history not ready — wait or retry /session",
    );
  }
});

it("keeps a failed selection blocked and lets /session retry it", async () => {
  const loadHistory = vi
    .fn()
    .mockRejectedValueOnce(new Error("history unavailable"))
    .mockResolvedValueOnce(selectedHistory(key, "selected"));
  const commands = selectionHarness({ historyLoaded: false }, { loadHistory }, (raw = key) =>
    select(raw),
  );
  const { state, actions } = commands;
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
  const commands = selectionHarness(
    { currentSessionId: "selected" },
    { loadHistory: () => history.promise },
  );
  const refreshing = commands.actions.loadHistory();
  try {
    await commands.sendMessage("send during refresh");
    expect(commands.sendChat).toHaveBeenCalledOnce();
  } finally {
    history.resolve(selectedHistory(key, "selected"));
    await refreshing;
  }
});

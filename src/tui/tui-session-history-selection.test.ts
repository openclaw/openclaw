import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTuiCommandHandlersHarness } from "./tui-command-handlers-test-support.js";
import {
  createBaseState,
  createTestSessionActions,
  makeTuiBackend,
} from "./tui-session-actions-test-support.js";

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
      client: makeTuiBackend({
        loadHistory: async () => {
          historyEntered.resolve();
          return history.promise;
        },
      }),
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
  },
);

it("selects a qualified global row from an already loaded bare-global conversation", async () => {
  const state = createBaseState({
    currentAgentId: "research",
    currentSessionKey: "global",
    historyLoaded: true,
  });
  const loadHistory = vi.fn(async () => ({
    messages: [],
    sessionId: "literal-row",
    sessionInfo: { key, sessionId: "literal-row" },
  }));
  const actions = createTestSessionActions({
    state,
    client: makeTuiBackend({ loadHistory }),
    resolveSessionSelection: (raw = "global") => ({ key: raw, agentId: "research" }),
  });
  await actions.setSession(key);
  expect(state.currentSessionKey).toBe(key);
  expect(state.currentSessionId).toBe("literal-row");
  expect(loadHistory).toHaveBeenCalledOnce();
});

it("retains the shipped qualified-global Home alias after an empty exact read", async () => {
  const state = stateFor();
  const loadHistory = vi
    .fn()
    .mockResolvedValueOnce({ messages: [] })
    .mockResolvedValueOnce({ messages: [], sessionId: "legacy-home" });
  const actions = createTestSessionActions({
    state,
    client: makeTuiBackend({
      loadHistory,
      describeSession: async () => ({ session: { key: "global", sessionId: "legacy-home" } }),
    }),
  });
  await expect(actions.loadHistory()).resolves.toMatchObject({ loaded: true });
  expect(loadHistory).toHaveBeenNthCalledWith(2, {
    sessionKey: "global",
    agentId: "research",
    limit: 200,
  });
  expect(state.currentSessionKey).toBe("global");
  expect(state.currentSessionId).toBe("legacy-home");
});

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

it("does not redirect after an exact history error", async () => {
  const state = stateFor();
  const loadHistory = vi.fn(async () => {
    throw new Error("history access refused");
  });
  const actions = createTestSessionActions({ state, client: makeTuiBackend({ loadHistory }) });
  await expect(actions.loadHistory()).resolves.toEqual({ loaded: false });
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

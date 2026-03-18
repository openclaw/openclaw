import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveTuiAliases } from "./tui-aliases.js";
import { createCommandHandlers } from "./tui-command-handlers.js";

vi.mock("./tui-aliases.js", async () => {
  const actual = await vi.importActual<typeof import("./tui-aliases.js")>("./tui-aliases.js");
  return {
    ...actual,
    saveTuiAliases: vi.fn().mockResolvedValue(undefined),
  };
});

type LoadHistoryMock = ReturnType<typeof vi.fn> & (() => Promise<void>);
type SetActivityStatusMock = ReturnType<typeof vi.fn> & ((text: string) => void);
type SetSessionMock = ReturnType<typeof vi.fn> & ((key: string) => Promise<void>);

beforeEach(() => {
  vi.mocked(saveTuiAliases).mockReset();
  vi.mocked(saveTuiAliases).mockResolvedValue(undefined);
});

function createHarness(params?: {
  sendChat?: ReturnType<typeof vi.fn>;
  patchSession?: ReturnType<typeof vi.fn>;
  resetSession?: ReturnType<typeof vi.fn>;
  setSession?: SetSessionMock;
  loadHistory?: LoadHistoryMock;
  refreshSessionInfo?: ReturnType<typeof vi.fn>;
  applySessionInfoFromPatch?: ReturnType<typeof vi.fn>;
  setActivityStatus?: SetActivityStatusMock;
  isConnected?: boolean;
  activeChatRunId?: string | null;
  tuiAliases?: Record<string, string>;
}) {
  const sendChat = params?.sendChat ?? vi.fn().mockResolvedValue({ runId: "r1" });
  const patchSession = params?.patchSession ?? vi.fn().mockResolvedValue({});
  const resetSession = params?.resetSession ?? vi.fn().mockResolvedValue({ ok: true });
  const setSession = params?.setSession ?? (vi.fn().mockResolvedValue(undefined) as SetSessionMock);
  const addUser = vi.fn();
  const addSystem = vi.fn();
  const requestRender = vi.fn();
  const noteLocalRunId = vi.fn();
  const noteLocalBtwRunId = vi.fn();
  const loadHistory =
    params?.loadHistory ?? (vi.fn().mockResolvedValue(undefined) as LoadHistoryMock);
  const refreshSessionInfo = params?.refreshSessionInfo ?? vi.fn().mockResolvedValue(undefined);
  const applySessionInfoFromPatch = params?.applySessionInfoFromPatch ?? vi.fn();
  const setActivityStatus = params?.setActivityStatus ?? (vi.fn() as SetActivityStatusMock);
  const refreshAutocomplete = vi.fn();
  const state = {
    currentSessionKey: "agent:main:main",
    activeChatRunId: params?.activeChatRunId ?? null,
    pendingOptimisticUserMessage: false,
    isConnected: params?.isConnected ?? true,
    sessionInfo: {},
    tuiAliases: params?.tuiAliases ?? {},
  };

  const { handleCommand } = createCommandHandlers({
    client: { sendChat, patchSession, resetSession } as never,
    chatLog: { addUser, addSystem } as never,
    tui: { requestRender } as never,
    opts: {},
    state: state as never,
    deliverDefault: false,
    openOverlay: vi.fn(),
    closeOverlay: vi.fn(),
    refreshSessionInfo: refreshSessionInfo as never,
    loadHistory,
    setSession,
    refreshAgents: vi.fn(),
    abortActive: vi.fn(),
    setActivityStatus,
    formatSessionKey: vi.fn(),
    applySessionInfoFromPatch: applySessionInfoFromPatch as never,
    noteLocalRunId,
    noteLocalBtwRunId,
    forgetLocalRunId: vi.fn(),
    forgetLocalBtwRunId: vi.fn(),
    requestExit: vi.fn(),
    refreshAutocomplete,
  });

  return {
    handleCommand,
    sendChat,
    patchSession,
    resetSession,
    setSession,
    addUser,
    addSystem,
    requestRender,
    loadHistory,
    refreshSessionInfo,
    applySessionInfoFromPatch,
    setActivityStatus,
    noteLocalRunId,
    noteLocalBtwRunId,
    refreshAutocomplete,
    state,
  };
}

describe("tui command handlers", () => {
  it("renders the sending indicator before chat.send resolves", async () => {
    let resolveSend: (value: { runId: string }) => void = () => {
      throw new Error("sendChat promise resolver was not initialized");
    };
    const sendPromise = new Promise<{ runId: string }>((resolve) => {
      resolveSend = (value) => resolve(value);
    });
    const sendChat = vi.fn(() => sendPromise);
    const setActivityStatus = vi.fn();

    const { handleCommand, requestRender } = createHarness({
      sendChat,
      setActivityStatus,
    });

    const pending = handleCommand("/context");
    await Promise.resolve();

    expect(setActivityStatus).toHaveBeenCalledWith("sending");
    const sendingOrder = setActivityStatus.mock.invocationCallOrder[0] ?? 0;
    const renderOrders = requestRender.mock.invocationCallOrder;
    expect(renderOrders.some((order) => order > sendingOrder)).toBe(true);

    resolveSend({ runId: "r1" });
    await pending;
    expect(setActivityStatus).toHaveBeenCalledWith("waiting");
  });

  it("forwards unknown slash commands to the gateway", async () => {
    const { handleCommand, sendChat, addUser, addSystem, requestRender } = createHarness();

    await handleCommand("/context");

    expect(addSystem).not.toHaveBeenCalled();
    expect(addUser).toHaveBeenCalledWith("/context");
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: "/context",
      }),
    );
    expect(requestRender).toHaveBeenCalled();
  });

  it("defers local run binding until gateway events provide a real run id", async () => {
    const { handleCommand, noteLocalRunId, state } = createHarness();

    await handleCommand("/context");

    expect(noteLocalRunId).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBeNull();
    expect(state.pendingOptimisticUserMessage).toBe(true);
  });

  it("sends /btw without hijacking the active main run", async () => {
    const setActivityStatus = vi.fn();
    const { handleCommand, sendChat, addUser, noteLocalRunId, noteLocalBtwRunId, state } =
      createHarness({
        activeChatRunId: "run-main",
        setActivityStatus,
      });

    await handleCommand("/btw what changed?");

    expect(addUser).not.toHaveBeenCalled();
    expect(noteLocalRunId).not.toHaveBeenCalled();
    expect(noteLocalBtwRunId).toHaveBeenCalledTimes(1);
    expect(state.activeChatRunId).toBe("run-main");
    expect(setActivityStatus).not.toHaveBeenCalledWith("sending");
    expect(setActivityStatus).not.toHaveBeenCalledWith("waiting");
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "/btw what changed?",
      }),
    );
  });

  it("creates unique session for /new and resets shared session for /reset", async () => {
    const loadHistory = vi.fn().mockResolvedValue(undefined);
    const setSessionMock = vi.fn().mockResolvedValue(undefined) as SetSessionMock;
    const { handleCommand, resetSession } = createHarness({
      loadHistory,
      setSession: setSessionMock,
    });

    await handleCommand("/new");
    await handleCommand("/reset");

    // /new creates a unique session key (isolates TUI client) (#39217)
    expect(setSessionMock).toHaveBeenCalledTimes(1);
    expect(setSessionMock).toHaveBeenCalledWith(
      expect.stringMatching(/^tui-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    );
    // /reset still resets the shared session
    expect(resetSession).toHaveBeenCalledTimes(1);
    expect(resetSession).toHaveBeenCalledWith("agent:main:main", "reset");
    expect(loadHistory).toHaveBeenCalledTimes(1); // /reset calls loadHistory directly; /new does so indirectly via setSession
  });

  it("reports send failures and marks activity status as error", async () => {
    const setActivityStatus = vi.fn();
    const { handleCommand, addSystem, state } = createHarness({
      sendChat: vi.fn().mockRejectedValue(new Error("gateway down")),
      setActivityStatus,
    });

    await handleCommand("/context");

    expect(addSystem).toHaveBeenCalledWith("send failed: Error: gateway down");
    expect(setActivityStatus).toHaveBeenLastCalledWith("error");
    expect(state.pendingOptimisticUserMessage).toBe(false);
  });

  it("sanitizes control sequences in /new and /reset failures", async () => {
    const setSession = vi.fn().mockRejectedValue(new Error("\u001b[31mboom\u001b[0m"));
    const resetSession = vi.fn().mockRejectedValue(new Error("\u001b[31mboom\u001b[0m"));
    const { handleCommand, addSystem } = createHarness({
      setSession,
      resetSession,
    });

    await handleCommand("/new");
    await handleCommand("/reset");

    expect(addSystem).toHaveBeenNthCalledWith(1, "new session failed: Error: boom");
    expect(addSystem).toHaveBeenNthCalledWith(2, "reset failed: Error: boom");
  });

  it("reports disconnected status and skips gateway send when offline", async () => {
    const { handleCommand, sendChat, addUser, addSystem, setActivityStatus } = createHarness({
      isConnected: false,
    });

    await handleCommand("/context");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("not connected to gateway — message not sent");
    expect(setActivityStatus).toHaveBeenLastCalledWith("disconnected");
  });

  it("rejects invalid /activation values before patching the session", async () => {
    const { handleCommand, patchSession, addSystem } = createHarness();

    await handleCommand("/activation sometimes");

    expect(patchSession).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("usage: /activation <mention|always>");
  });

  it("patches the session for valid /activation values", async () => {
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const applySessionInfoFromPatch = vi.fn();
    const patchSession = vi.fn().mockResolvedValue({ groupActivation: "always" });
    const { handleCommand, addSystem } = createHarness({
      patchSession,
      refreshSessionInfo,
      applySessionInfoFromPatch,
    });

    await handleCommand("/activation always");

    expect(patchSession).toHaveBeenCalledWith({
      key: "agent:main:main",
      groupActivation: "always",
    });
    expect(addSystem).toHaveBeenCalledWith("activation set to always");
    expect(applySessionInfoFromPatch).toHaveBeenCalledWith({ groupActivation: "always" });
    expect(refreshSessionInfo).toHaveBeenCalledTimes(1);
  });

  it("saves a quoted alias and refreshes autocomplete", async () => {
    const { handleCommand, addSystem, refreshAutocomplete, state } = createHarness();

    await handleCommand('/alias review "check the PR and address comments"');

    expect(state.tuiAliases).toMatchObject({
      review: "check the PR and address comments",
    });
    expect(addSystem).toHaveBeenCalledWith("alias saved: review");
    expect(refreshAutocomplete).toHaveBeenCalled();
  });

  it("runs a saved alias as a normal message", async () => {
    const { handleCommand, sendChat, addUser } = createHarness({
      tuiAliases: {
        review: "check the PR and address comments",
      },
    });

    await handleCommand("/alias review");

    expect(addUser).toHaveBeenCalledWith("check the PR and address comments");
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "check the PR and address comments",
      }),
    );
  });

  it("removes aliases with /unalias", async () => {
    const { handleCommand, addSystem, refreshAutocomplete, state } = createHarness({
      tuiAliases: {
        review: "check the PR",
      },
    });

    await handleCommand("/unalias review");

    expect(state.tuiAliases).toEqual({});
    expect(addSystem).toHaveBeenCalledWith("alias removed: review");
    expect(refreshAutocomplete).toHaveBeenCalled();
  });

  it("does not mutate aliases in memory when save fails", async () => {
    vi.mocked(saveTuiAliases).mockRejectedValueOnce(new Error("disk full"));
    const { handleCommand, addSystem, refreshAutocomplete, state } = createHarness();

    await handleCommand('/alias review "check the PR"');

    expect(state.tuiAliases).toEqual({});
    expect(addSystem).toHaveBeenCalledWith("alias save failed: Error: disk full");
    expect(refreshAutocomplete).not.toHaveBeenCalled();
  });

  it("rejects empty quoted alias prompts instead of running the alias", async () => {
    const { handleCommand, addSystem, sendChat } = createHarness({
      tuiAliases: {
        review: "existing prompt",
      },
    });

    await handleCommand('/alias review ""');

    expect(addSystem).toHaveBeenCalledWith("usage: /alias <name> <prompt> or /alias <name>");
    expect(sendChat).not.toHaveBeenCalled();
  });

  it("does not delete aliases in memory when remove fails", async () => {
    vi.mocked(saveTuiAliases).mockRejectedValueOnce(new Error("disk full"));
    const { handleCommand, addSystem, refreshAutocomplete, state } = createHarness({
      tuiAliases: {
        review: "check the PR",
      },
    });

    await handleCommand("/unalias review");

    expect(state.tuiAliases).toEqual({
      review: "check the PR",
    });
    expect(addSystem).toHaveBeenCalledWith("alias remove failed: Error: disk full");
    expect(refreshAutocomplete).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { createCommandHandlers } from "./tui-command-handlers.js";

type LoadHistoryMock = ReturnType<typeof vi.fn> & (() => Promise<void>);
type SetActivityStatusMock = ReturnType<typeof vi.fn> & ((text: string) => void);
type SetSessionMock = ReturnType<typeof vi.fn> & ((key: string) => Promise<void>);
type EnqueueQueuedMessageMock = ReturnType<typeof vi.fn> & ((text: string) => number);
type GetQueuedMessageCountMock = ReturnType<typeof vi.fn> & (() => number);
type ShouldQueuePromptMock = ReturnType<typeof vi.fn> & (() => boolean);
type FlushQueuedMessageMock = ReturnType<typeof vi.fn> & (() => Promise<boolean>);

function createHarness(params?: {
  sendChat?: ReturnType<typeof vi.fn>;
  resetSession?: ReturnType<typeof vi.fn>;
  setSession?: SetSessionMock;
  loadHistory?: LoadHistoryMock;
  setActivityStatus?: SetActivityStatusMock;
  enqueueQueuedMessage?: EnqueueQueuedMessageMock;
  getQueuedMessageCount?: GetQueuedMessageCountMock;
  shouldQueuePrompt?: ShouldQueuePromptMock;
  flushQueuedMessage?: FlushQueuedMessageMock;
  isConnected?: boolean;
  activeChatRunId?: string | null;
}) {
  const sendChat = params?.sendChat ?? vi.fn().mockResolvedValue({ runId: "r1" });
  const resetSession = params?.resetSession ?? vi.fn().mockResolvedValue({ ok: true });
  const setSession = params?.setSession ?? (vi.fn().mockResolvedValue(undefined) as SetSessionMock);
  const addUser = vi.fn();
  const addSystem = vi.fn();
  const requestRender = vi.fn();
  const noteLocalRunId = vi.fn();
  const noteLocalBtwRunId = vi.fn();
  const enqueueQueuedMessage =
    params?.enqueueQueuedMessage ?? (vi.fn().mockReturnValue(1) as EnqueueQueuedMessageMock);
  const getQueuedMessageCount =
    params?.getQueuedMessageCount ?? (vi.fn().mockReturnValue(0) as GetQueuedMessageCountMock);
  const shouldQueuePrompt =
    params?.shouldQueuePrompt ?? (vi.fn().mockReturnValue(false) as ShouldQueuePromptMock);
  const flushQueuedMessage =
    params?.flushQueuedMessage ?? (vi.fn().mockResolvedValue(false) as FlushQueuedMessageMock);
  const loadHistory =
    params?.loadHistory ?? (vi.fn().mockResolvedValue(undefined) as LoadHistoryMock);
  const setActivityStatus = params?.setActivityStatus ?? (vi.fn() as SetActivityStatusMock);
  const state = {
    currentSessionKey: "agent:main:main",
    activeChatRunId: params?.activeChatRunId ?? null,
    isConnected: params?.isConnected ?? true,
    sessionInfo: {},
  };

  const { handleCommand, sendMessageInternal } = createCommandHandlers({
    client: { sendChat, resetSession } as never,
    chatLog: { addUser, addSystem } as never,
    tui: { requestRender } as never,
    opts: {},
    state: state as never,
    deliverDefault: false,
    openOverlay: vi.fn(),
    closeOverlay: vi.fn(),
    refreshSessionInfo: vi.fn(),
    loadHistory,
    setSession,
    refreshAgents: vi.fn(),
    abortActive: vi.fn(),
    setActivityStatus,
    formatSessionKey: vi.fn(),
    applySessionInfoFromPatch: vi.fn(),
    noteLocalRunId,
    noteLocalBtwRunId,
    getQueuedMessageCount,
    enqueueQueuedMessage,
    shouldQueuePrompt,
    flushQueuedMessage,
    forgetLocalRunId: vi.fn(),
    forgetLocalBtwRunId: vi.fn(),
    requestExit: vi.fn(),
  });

  return {
    handleCommand,
    sendMessageInternal,
    sendChat,
    resetSession,
    setSession,
    addUser,
    addSystem,
    requestRender,
    loadHistory,
    setActivityStatus,
    noteLocalRunId,
    noteLocalBtwRunId,
    getQueuedMessageCount,
    enqueueQueuedMessage,
    shouldQueuePrompt,
    flushQueuedMessage,
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

  it("queues normal prompts while another run is active", async () => {
    const enqueueQueuedMessage = vi.fn().mockReturnValue(2);
    const shouldQueuePrompt = vi.fn().mockReturnValue(true);
    const { handleCommand, sendChat, addUser, addSystem, state } = createHarness({
      activeChatRunId: "run-active",
      enqueueQueuedMessage,
      shouldQueuePrompt,
    });

    await handleCommand("/context");

    expect(enqueueQueuedMessage).toHaveBeenCalledWith("/context");
    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("queued prompt (2 pending)");
    expect(state.activeChatRunId).toBe("run-active");
  });

  it("sends immediately when the tracked active run is stale", async () => {
    const shouldQueuePrompt = vi.fn().mockReturnValue(false);
    const { handleCommand, sendChat, addUser, addSystem, enqueueQueuedMessage, state } =
      createHarness({
        activeChatRunId: "run-stale",
        shouldQueuePrompt,
      });

    await handleCommand("/context");

    expect(enqueueQueuedMessage).not.toHaveBeenCalled();
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: "/context",
      }),
    );
    expect(addUser).toHaveBeenCalledWith("/context");
    expect(addSystem).not.toHaveBeenCalledWith(expect.stringContaining("queued prompt"));
    expect(state.activeChatRunId).not.toBe("run-stale");
  });

  it("flushes queued backlog before sending behind a stale active run", async () => {
    const enqueueQueuedMessage = vi.fn().mockReturnValue(3);
    const shouldQueuePrompt = vi.fn().mockReturnValue(false);
    const flushQueuedMessage = vi.fn().mockResolvedValue(true);
    const { handleCommand, sendChat, addUser, addSystem, state } = createHarness({
      activeChatRunId: "run-stale",
      enqueueQueuedMessage,
      getQueuedMessageCount: vi.fn().mockReturnValue(2),
      shouldQueuePrompt,
      flushQueuedMessage,
    });

    await handleCommand("/context");

    expect(enqueueQueuedMessage).toHaveBeenCalledWith("/context");
    expect(flushQueuedMessage).toHaveBeenCalledTimes(1);
    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("queued prompt (3 pending)");
    expect(state.activeChatRunId).toBeNull();
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
    const { handleCommand, addSystem } = createHarness({
      sendChat: vi.fn().mockRejectedValue(new Error("gateway down")),
      setActivityStatus,
    });

    await handleCommand("/context");

    expect(addSystem).toHaveBeenCalledWith("send failed: Error: gateway down");
    expect(setActivityStatus).toHaveBeenLastCalledWith("error");
  });

  it("returns false when a queued dispatch send throws before the run can continue", async () => {
    const setActivityStatus = vi.fn();
    const { sendMessageInternal, addSystem } = createHarness({
      sendChat: vi.fn().mockRejectedValue(new Error("gateway down")),
      setActivityStatus,
    });

    await expect(sendMessageInternal("/context", { allowQueue: false })).resolves.toBe(false);

    expect(addSystem).toHaveBeenCalledWith("send failed: Error: gateway down");
    expect(setActivityStatus).toHaveBeenLastCalledWith("error");
  });

  it("delays queued prompt echo until the dispatch send succeeds", async () => {
    const sendChat = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway down"))
      .mockResolvedValueOnce({ runId: "r2" });
    const { sendMessageInternal, addUser } = createHarness({
      sendChat,
    });

    await expect(
      sendMessageInternal("/context", {
        allowQueue: false,
        echoUserBeforeSend: false,
      }),
    ).resolves.toBe(false);
    expect(addUser).not.toHaveBeenCalled();

    await expect(
      sendMessageInternal("/context", {
        allowQueue: false,
        echoUserBeforeSend: false,
      }),
    ).resolves.toBe(true);

    expect(addUser).toHaveBeenCalledTimes(1);
    expect(addUser).toHaveBeenCalledWith("/context");
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
});

import { describe, expect, it, vi } from "vitest";
import { createCommandHandlers } from "./tui-command-handlers.js";

type LoadHistoryMock = ReturnType<typeof vi.fn> & (() => Promise<void>);
type SetActivityStatusMock = ReturnType<typeof vi.fn> & ((text: string) => void);

function createHarness(params?: {
  sendChat?: ReturnType<typeof vi.fn>;
  resetSession?: ReturnType<typeof vi.fn>;
  loadHistory?: LoadHistoryMock;
  setActivityStatus?: SetActivityStatusMock;
}) {
  const sendChat = params?.sendChat ?? vi.fn().mockResolvedValue({ runId: "r1" });
  const resetSession = params?.resetSession ?? vi.fn().mockResolvedValue({ ok: true });
  const addUser = vi.fn();
  const addSystem = vi.fn();
  const requestRender = vi.fn();
  const loadHistory =
    params?.loadHistory ?? (vi.fn().mockResolvedValue(undefined) as LoadHistoryMock);
  const setActivityStatus = params?.setActivityStatus ?? (vi.fn() as SetActivityStatusMock);

  const { handleCommand } = createCommandHandlers({
    client: { sendChat, resetSession } as never,
    chatLog: { addUser, addSystem } as never,
    tui: { requestRender } as never,
    opts: {},
    state: {
      currentSessionKey: "agent:main:main",
      activeChatRunId: null,
      sessionInfo: {},
    } as never,
    deliverDefault: false,
    openOverlay: vi.fn(),
    closeOverlay: vi.fn(),
    refreshSessionInfo: vi.fn(),
    loadHistory,
    setSession: vi.fn(),
    refreshAgents: vi.fn(),
    abortActive: vi.fn(),
    setActivityStatus,
    formatSessionKey: vi.fn(),
    applySessionInfoFromPatch: vi.fn(),
    noteLocalRunId: vi.fn(),
    forgetLocalRunId: vi.fn(),
    requestExit: vi.fn(),
  });

  return {
    handleCommand,
    sendChat,
    resetSession,
    addUser,
    addSystem,
    requestRender,
    loadHistory,
    setActivityStatus,
  };
}

describe("tui command handlers", () => {
  it("renders the sending indicator before chat.send resolves", async () => {
    let resolveSend: ((value: { runId: string }) => void) | null = null;
    const sendChat = vi.fn(
      () =>
        new Promise<{ runId: string }>((resolve) => {
          resolveSend = resolve;
        }),
    );
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

    if (typeof resolveSend !== "function") {
      throw new Error("expected sendChat to be pending");
    }
    (resolveSend as (value: { runId: string }) => void)({ runId: "r1" });
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

  it("passes reset reason when handling /new and /reset", async () => {
    const loadHistory = vi.fn().mockResolvedValue(undefined);
    const { handleCommand, resetSession } = createHarness({ loadHistory });

    await handleCommand("/new");
    await handleCommand("/reset");

    expect(resetSession).toHaveBeenNthCalledWith(1, "agent:main:main", "new");
    expect(resetSession).toHaveBeenNthCalledWith(2, "agent:main:main", "reset");
    expect(loadHistory).toHaveBeenCalledTimes(2);
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
});

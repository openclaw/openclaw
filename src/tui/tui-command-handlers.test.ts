import { describe, expect, it, vi } from "vitest";
import { createCommandHandlers } from "./tui-command-handlers.js";

describe("tui command handlers", () => {
  it("forwards unknown slash commands to the gateway", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "r1" });
    const addUser = vi.fn();
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const setActivityStatus = vi.fn();

    const { handleCommand } = createCommandHandlers({
      client: { sendChat } as never,
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
      loadHistory: vi.fn(),
      setSession: vi.fn(),
      refreshAgents: vi.fn(),
      abortActive: vi.fn(),
      setActivityStatus,
      formatSessionKey: vi.fn(),
      applySessionInfoFromPatch: vi.fn(),
      noteLocalRunId: vi.fn(),
    });

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
    const resetSession = vi.fn().mockResolvedValue({ ok: true });
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const loadHistory = vi.fn().mockResolvedValue(undefined);

    const { handleCommand } = createCommandHandlers({
      client: { resetSession } as never,
      chatLog: { addSystem } as never,
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
      setActivityStatus: vi.fn(),
      formatSessionKey: vi.fn(),
      applySessionInfoFromPatch: vi.fn(),
      noteLocalRunId: vi.fn(),
    });

    await handleCommand("/new");
    await handleCommand("/reset");

    expect(resetSession).toHaveBeenNthCalledWith(1, "agent:main:main", "new");
    expect(resetSession).toHaveBeenNthCalledWith(2, "agent:main:main", "reset");
    expect(loadHistory).toHaveBeenCalledTimes(2);
  });

  it("queues messages while a run is active and flushes them in order", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "r1" });
    const addUser = vi.fn();
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const setActivityStatus = vi.fn();
    const state: {
      currentSessionKey: string;
      activeChatRunId: string | null;
      sessionInfo: Record<string, never>;
    } = {
      currentSessionKey: "agent:main:main",
      activeChatRunId: "active-run",
      sessionInfo: {},
    };

    const { sendMessage, flushQueuedMessage } = createCommandHandlers({
      client: { sendChat } as never,
      chatLog: { addUser, addSystem } as never,
      tui: { requestRender } as never,
      opts: {},
      state: state as never,
      deliverDefault: false,
      openOverlay: vi.fn(),
      closeOverlay: vi.fn(),
      refreshSessionInfo: vi.fn(),
      loadHistory: vi.fn(),
      setSession: vi.fn(),
      refreshAgents: vi.fn(),
      abortActive: vi.fn(),
      setActivityStatus,
      formatSessionKey: vi.fn(),
      applySessionInfoFromPatch: vi.fn(),
      noteLocalRunId: vi.fn(),
      forgetLocalRunId: vi.fn(),
    });

    await sendMessage("first queued");
    await sendMessage("second queued");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).toHaveBeenNthCalledWith(1, "first queued");
    expect(addUser).toHaveBeenNthCalledWith(2, "second queued");
    expect(addSystem).toHaveBeenNthCalledWith(1, "queued (1)");
    expect(addSystem).toHaveBeenNthCalledWith(2, "queued (2)");

    state.activeChatRunId = null;
    await flushQueuedMessage();
    expect(sendChat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: "first queued", sessionKey: "agent:main:main" }),
    );
    expect(addSystem).toHaveBeenCalledWith("sending queued message (1 left)");

    state.activeChatRunId = null;
    await flushQueuedMessage();
    expect(sendChat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: "second queued", sessionKey: "agent:main:main" }),
    );

    expect(setActivityStatus).toHaveBeenCalledWith("sending");
    expect(setActivityStatus).toHaveBeenCalledWith("waiting");
  });
});

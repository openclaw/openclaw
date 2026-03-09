import { describe, expect, it, vi } from "vitest";
import { createCommandHandlers, partitionModelItems } from "./tui-command-handlers.js";

type LoadHistoryMock = ReturnType<typeof vi.fn> & (() => Promise<void>);
type SetActivityStatusMock = ReturnType<typeof vi.fn> & ((text: string) => void);
type SetSessionMock = ReturnType<typeof vi.fn> & ((key: string) => Promise<void>);

function createHarness(params?: {
  sendChat?: ReturnType<typeof vi.fn>;
  resetSession?: ReturnType<typeof vi.fn>;
  setSession?: SetSessionMock;
  loadHistory?: LoadHistoryMock;
  setActivityStatus?: SetActivityStatusMock;
  isConnected?: boolean;
}) {
  const sendChat = params?.sendChat ?? vi.fn().mockResolvedValue({ runId: "r1" });
  const resetSession = params?.resetSession ?? vi.fn().mockResolvedValue({ ok: true });
  const setSession = params?.setSession ?? (vi.fn().mockResolvedValue(undefined) as SetSessionMock);
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
      isConnected: params?.isConnected ?? true,
      sessionInfo: {},
    } as never,
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
    noteLocalRunId: vi.fn(),
    forgetLocalRunId: vi.fn(),
    requestExit: vi.fn(),
  });

  return {
    handleCommand,
    sendChat,
    resetSession,
    setSession,
    addUser,
    addSystem,
    requestRender,
    loadHistory,
    setActivityStatus,
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

describe("partitionModelItems", () => {
  const models = [
    { id: "gpt-4o", provider: "openai", name: "GPT-4o", contextWindow: 128_000 },
    {
      id: "claude-opus-4-6",
      provider: "anthropic",
      name: "Claude Opus 4.6",
      contextWindow: 200_000,
      reasoning: true,
    },
    { id: "gemini-2.5-pro", provider: "google", name: "Gemini 2.5 Pro" },
    { id: "llama-3", provider: "groq", name: "Llama 3" },
  ];

  it("places authenticated providers before unauthenticated", () => {
    const items = partitionModelItems(models, (p) => p === "anthropic");

    expect(items[0].value).toBe("anthropic/claude-opus-4-6");
    expect(items.length).toBe(4);
    expect(items[1].value).toBe("openai/gpt-4o");
    expect(items[2].value).toBe("google/gemini-2.5-pro");
    expect(items[3].value).toBe("groq/llama-3");
  });

  it("preserves original order when no models have auth", () => {
    const items = partitionModelItems(models, () => false);

    expect(items.map((i) => i.value)).toEqual([
      "openai/gpt-4o",
      "anthropic/claude-opus-4-6",
      "google/gemini-2.5-pro",
      "groq/llama-3",
    ]);
  });

  it("preserves original order when all models have auth", () => {
    const items = partitionModelItems(models, () => true);

    expect(items.map((i) => i.value)).toEqual([
      "openai/gpt-4o",
      "anthropic/claude-opus-4-6",
      "google/gemini-2.5-pro",
      "groq/llama-3",
    ]);
  });

  it("includes context window and reasoning in description", () => {
    const items = partitionModelItems(models, () => true);
    const anthropic = items.find((i) => i.value === "anthropic/claude-opus-4-6");

    expect(anthropic!.description).toContain("Claude Opus 4.6");
    expect(anthropic!.description).toContain("ctx 195k");
    expect(anthropic!.description).toContain("reasoning");
  });

  it("handles multiple authenticated providers", () => {
    const authed = new Set(["openai", "google"]);
    const items = partitionModelItems(models, (p) => authed.has(p));

    expect(items.map((i) => i.value)).toEqual([
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
      "anthropic/claude-opus-4-6",
      "groq/llama-3",
    ]);
  });

  it("returns empty array for empty models list", () => {
    expect(partitionModelItems([], () => true)).toEqual([]);
  });
});

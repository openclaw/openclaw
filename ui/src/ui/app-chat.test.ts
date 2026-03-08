import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { handleSendChat, isChatBusy, type ChatHost } from "./app-chat.ts";
import type { OpenClawApp } from "./app.ts";

// Mock the sendChatMessage function from controllers/chat.ts
vi.mock("./controllers/chat.ts", () => ({
  sendChatMessage: vi.fn(),
  loadChatHistory: vi.fn(),
  abortChatRun: vi.fn(),
}));

// Mock other dependencies
vi.mock("./app-scroll.ts", () => ({
  scheduleChatScroll: vi.fn(),
}));

vi.mock("./app-settings.ts", () => ({
  setLastActiveSessionKey: vi.fn(),
}));

vi.mock("./app-tool-stream.ts", () => ({
  resetToolStream: vi.fn(),
}));

function createChatHost(overrides: Partial<ChatHost> = {}): ChatHost {
  return {
    connected: true,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    sessionKey: "main",
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    refreshSessionsAfterChat: new Set(),
    ...overrides,
  };
}

describe("handleSendChat", () => {
  let mockSendChatMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Get the mocked function
    const chatModule = await import("./controllers/chat.ts");
    mockSendChatMessage = vi.mocked(chatModule.sendChatMessage);
    // Default: resolve with a run ID
    mockSendChatMessage.mockResolvedValue("test-run-id");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prevents double-send by clearing message synchronously and setting chatSending", async () => {
    const host = createChatHost({
      chatMessage: "Hello",
      connected: true,
    });

    // Create a deferred promise to simulate slow network
    let resolveSend: (value: string | null) => void;
    const slowSendPromise = new Promise<string | null>((resolve) => {
      resolveSend = resolve;
    });
    mockSendChatMessage.mockReturnValue(slowSendPromise);

    // Start first send (will hang until we resolve)
    const firstCall = handleSendChat(host as unknown as OpenClawApp);

    // Immediately after calling handleSendChat:
    // 1. chatSending should be true (synchronously set before async work)
    // 2. chatMessage should be cleared (also synchronous)
    expect(host.chatSending).toBe(true);
    expect(host.chatMessage).toBe("");

    // A rapid second call won't enqueue because message is already cleared.
    // This is the primary defense against double-send.
    const secondCall = handleSendChat(host as unknown as OpenClawApp);

    // No message queued because message was empty
    expect(host.chatQueue).toHaveLength(0);
    // sendChatMessage should only have been called once
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);

    // Resolve the slow send
    resolveSend!("run-id-1");

    // Wait for both calls to complete
    await Promise.all([firstCall, secondCall]);
  });

  it("enqueues rapid second message when messageOverride preserves content", async () => {
    const host = createChatHost({
      chatMessage: "", // Will be overridden
      connected: true,
    });

    // Create a deferred promise to simulate slow network
    let resolveSend: (value: string | null) => void;
    const slowSendPromise = new Promise<string | null>((resolve) => {
      resolveSend = resolve;
    });
    mockSendChatMessage.mockReturnValue(slowSendPromise);

    // Start first send with explicit message (doesn't clear host.chatMessage)
    const firstCall = handleSendChat(host as unknown as OpenClawApp, "First message");

    // chatSending should be true synchronously
    expect(host.chatSending).toBe(true);

    // Rapid second call with another explicit message
    const secondCall = handleSendChat(host as unknown as OpenClawApp, "Second message");

    // Second message should be queued because isChatBusy returns true
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0].text).toBe("Second message");
    // sendChatMessage should only have been called once
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);

    // Resolve the slow send
    resolveSend!("run-id-1");

    await Promise.all([firstCall, secondCall]);
  });

  it("enqueues message when already busy with runId", async () => {
    const host = createChatHost({
      chatMessage: "Second message",
      chatRunId: "existing-run",
      chatSending: false,
      connected: true,
    });

    await handleSendChat(host as unknown as OpenClawApp);

    // Should enqueue since chatRunId is set
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0].text).toBe("Second message");
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it("enqueues message when chatSending is true", async () => {
    const host = createChatHost({
      chatMessage: "Queued message",
      chatSending: true,
      connected: true,
    });

    await handleSendChat(host as unknown as OpenClawApp);

    expect(host.chatQueue).toHaveLength(1);
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it("does not send empty message", async () => {
    const host = createChatHost({
      chatMessage: "   ", // whitespace only
      connected: true,
    });

    await handleSendChat(host as unknown as OpenClawApp);

    expect(mockSendChatMessage).not.toHaveBeenCalled();
    expect(host.chatQueue).toHaveLength(0);
  });

  it("clears message and attachments after send starts", async () => {
    const host = createChatHost({
      chatMessage: "Test message",
      chatAttachments: [
        { id: "att-1", dataUrl: "data:image/png;base64,abc", mimeType: "image/png" },
      ],
      connected: true,
    });

    const sendPromise = handleSendChat(host as unknown as OpenClawApp);

    // Message and attachments should be cleared immediately (before send completes)
    expect(host.chatMessage).toBe("");
    expect(host.chatAttachments).toHaveLength(0);

    await sendPromise;
  });

  it("handles stop command by aborting instead of sending", async () => {
    const host = createChatHost({
      chatMessage: "/stop",
      connected: true,
    });

    const chatModule = await import("./controllers/chat.ts");
    const mockAbortChatRun = vi.mocked(chatModule.abortChatRun);

    await handleSendChat(host as unknown as OpenClawApp);

    expect(mockAbortChatRun).toHaveBeenCalled();
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });
});

describe("isChatBusy", () => {
  it("returns false when neither sending nor has runId", () => {
    const host = createChatHost({ chatSending: false, chatRunId: null });
    expect(isChatBusy(host)).toBe(false);
  });

  it("returns true when chatSending is true", () => {
    const host = createChatHost({ chatSending: true, chatRunId: null });
    expect(isChatBusy(host)).toBe(true);
  });

  it("returns true when chatRunId is set", () => {
    const host = createChatHost({ chatSending: false, chatRunId: "run-123" });
    expect(isChatBusy(host)).toBe(true);
  });

  it("returns true when both sending and has runId", () => {
    const host = createChatHost({ chatSending: true, chatRunId: "run-123" });
    expect(isChatBusy(host)).toBe(true);
  });
});

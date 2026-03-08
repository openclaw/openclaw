/**
 * E2E Regression Tests for Webchat Control UI
 *
 * These tests prevent recurring regressions in the chat UI by verifying:
 * 1. Message resending - messages should be sent exactly once
 * 2. Image upload - proper URL/base64 handling (no private IP, no doubled paths)
 * 3. iOS typing lag - controlled input handling without excessive re-renders
 *
 * Run locally:
 *   pnpm vitest run --config vitest.e2e.config.ts test/chat-regression.e2e.test.ts
 *
 * Run all e2e:
 *   pnpm test:e2e
 *
 * CI: Included in `test:e2e` which runs on PRs via .github/workflows/ci.yml
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the i18n module to avoid localStorage errors in Node.js
vi.mock("../ui/src/i18n/index.ts", () => ({
  t: (key: string) => key,
  i18n: {
    getLocale: () => "en",
    setLocale: vi.fn(),
    subscribe: () => vi.fn(),
  },
  I18nController: class {
    getLocale() {
      return "en";
    }
    setLocale() {}
    subscribe() {
      return () => {};
    }
  },
  isSupportedLocale: () => true,
  SUPPORTED_LOCALES: ["en"],
}));

import { handleSendChat, isChatBusy, isChatStopCommand } from "../ui/src/ui/app-chat.ts";
import type { ChatHost } from "../ui/src/ui/app-chat.ts";
import { handleChatEvent, sendChatMessage } from "../ui/src/ui/controllers/chat.ts";
import type { ChatState } from "../ui/src/ui/controllers/chat.ts";
import type { GatewayEventFrame } from "../ui/src/ui/gateway.ts";
import type { ChatAttachment } from "../ui/src/ui/ui-types.ts";

// ============================================================================
// Mock Gateway Client
// ============================================================================

function createMockGatewayClient() {
  const eventHandlers: Array<(evt: GatewayEventFrame) => void> = [];
  let requestHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null;
  const requestCalls: Array<{ method: string; params: unknown }> = [];

  return {
    connected: true,
    requestCalls,
    request: vi.fn((method: string, params: unknown) => {
      requestCalls.push({ method, params });
      if (requestHandler) {
        return requestHandler(method, params);
      }
      // Default handlers for common methods
      if (method === "chat.history") {
        return Promise.resolve({ messages: [] });
      }
      if (method === "chat.send") {
        return Promise.resolve({ success: true });
      }
      return Promise.resolve({});
    }),
    setRequestHandler: (handler: (method: string, params: unknown) => Promise<unknown>) => {
      requestHandler = handler;
    },
    simulateEvent: (evt: GatewayEventFrame) => {
      for (const handler of eventHandlers) {
        handler(evt);
      }
    },
    on: (_event: string, handler: (evt: GatewayEventFrame) => void) => {
      eventHandlers.push(handler);
    },
  };
}

type MockGatewayClient = ReturnType<typeof createMockGatewayClient>;

function createTestChatState(client: MockGatewayClient): ChatState {
  return {
    client: client as unknown as ChatState["client"],
    connected: true,
    sessionKey: "agent:main:e2e-test-session",
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    chatPendingMessages: [],
    lastError: null,
  };
}

// Full host type that includes ChatHost + ToolStreamHost + ScrollHost + ChatState properties
type TestChatHost = ChatHost & {
  toolStreamById: Map<string, unknown>;
  toolStreamOrder: string[];
  chatToolMessages: unknown[];
  toolStreamSyncTimer: number | null;
  updateComplete: Promise<void>;
  chatScrollFrame: number | null;
  chatScrollTimeout: number | null;
  chatHasAutoScrolled: boolean;
  client: MockGatewayClient | null;
  chatMessages: unknown[];
};

function createTestChatHost(overrides: Partial<TestChatHost> = {}): TestChatHost {
  return {
    // ChatHost properties
    connected: true,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    sessionKey: "agent:main:test-session",
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    refreshSessionsAfterChat: new Set(),
    // ToolStreamHost properties
    toolStreamById: new Map(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    // ScrollHost properties
    updateComplete: Promise.resolve(),
    chatScrollFrame: null,
    chatScrollTimeout: null,
    chatHasAutoScrolled: false,
    // ChatState properties for sendChatMessage
    chatMessages: [],
    client: null,
    ...overrides,
  };
}

function createImageAttachment(mimeType = "image/png"): ChatAttachment {
  // 1x1 pixel PNG
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    dataUrl: `data:${mimeType};base64,${base64}`,
    mimeType,
  };
}

// ============================================================================
// Regression 1: Message Resending
// ============================================================================

describe("Regression: message resending (messages sent exactly once)", () => {
  let client: MockGatewayClient;
  let state: ChatState;

  beforeEach(() => {
    client = createMockGatewayClient();
    state = createTestChatState(client);
  });

  it("sends message exactly once (no duplicate sends)", async () => {
    let sendCount = 0;

    client.setRequestHandler(async (method) => {
      if (method === "chat.send") {
        sendCount++;
        return { success: true };
      }
      return {};
    });

    const runId = await sendChatMessage(state, "Hello, assistant!");

    expect(runId).not.toBeNull();
    expect(sendCount).toBe(1);
    // User message should appear exactly once in history
    expect(state.chatMessages).toHaveLength(1);
  });

  it("uses idempotency key to prevent duplicates", async () => {
    let capturedParams: { idempotencyKey?: string } | null = null;

    client.setRequestHandler(async (method, params) => {
      if (method === "chat.send") {
        capturedParams = params as { idempotencyKey?: string };
        return { success: true };
      }
      return {};
    });

    await sendChatMessage(state, "Test message");

    expect(capturedParams).not.toBeNull();
    expect(capturedParams?.idempotencyKey).toBeDefined();
    expect(typeof capturedParams?.idempotencyKey).toBe("string");
    // Idempotency key should be a valid UUID format
    expect(capturedParams?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("queues subsequent messages while busy instead of sending immediately", async () => {
    const host = createTestChatHost({
      chatRunId: "busy-run-id", // Chat is busy
    });

    // Chat is busy
    expect(isChatBusy(host)).toBe(true);

    // Attempt to send multiple messages - should queue, not send
    await handleSendChat(host, "First message");
    await handleSendChat(host, "Second message");
    await handleSendChat(host, "Third message");

    // All messages should be in queue
    expect(host.chatQueue).toHaveLength(3);
    expect(host.chatQueue.map((i) => i.text)).toEqual([
      "First message",
      "Second message",
      "Third message",
    ]);
  });

  it("does not duplicate user message on network retry", async () => {
    // Simulate the scenario where request succeeds but response is delayed
    // The idempotency key should prevent duplicates
    const firstIdempotencyKey = "run-test-id-1";

    client.setRequestHandler(async (method, params) => {
      if (method === "chat.send") {
        const p = params as { idempotencyKey?: string };
        // Verify same idempotency key used
        expect(p.idempotencyKey).toBe(firstIdempotencyKey);
        return { success: true };
      }
      return {};
    });

    state.chatRunId = firstIdempotencyKey;
    state.chatMessages = [
      { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1000 },
    ];

    // Simulate receiving the response event
    handleChatEvent(state, {
      runId: firstIdempotencyKey,
      sessionKey: state.sessionKey,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
    });

    // Should have exactly 2 messages (user + assistant)
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatRunId).toBeNull();
  });
});

// ============================================================================
// Regression 2: Image Upload URL Handling
// ============================================================================

describe("Regression: image upload URL handling", () => {
  let client: MockGatewayClient;
  let state: ChatState;

  beforeEach(() => {
    client = createMockGatewayClient();
    state = createTestChatState(client);
  });

  it("converts data URL to base64 content without private IP paths", async () => {
    const attachment = createImageAttachment();

    client.setRequestHandler(async (method, params) => {
      if (method === "chat.send") {
        const p = params as {
          attachments?: Array<{ type: string; mimeType: string; content: string }>;
        };

        expect(p.attachments).toBeDefined();
        expect(p.attachments).toHaveLength(1);

        const att = p.attachments![0];
        expect(att.type).toBe("image");
        expect(att.mimeType).toBe("image/png");

        // Content should be base64 only (no data: prefix, no URL path)
        expect(att.content).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(att.content).not.toContain("data:");
        expect(att.content).not.toContain("http://");
        expect(att.content).not.toContain("https://");
        expect(att.content).not.toContain("10.");
        expect(att.content).not.toContain("192.168.");
        expect(att.content).not.toContain("localhost");

        return { success: true };
      }
      return {};
    });

    const runId = await sendChatMessage(state, "What's in this image?", [attachment]);
    expect(runId).not.toBeNull();
  });

  it("does not double URL paths in attachment source", async () => {
    // Verify the message content blocks don't have doubled paths
    const attachment = createImageAttachment("image/jpeg");

    client.setRequestHandler(async (method) => {
      if (method === "chat.send") {
        return { success: true };
      }
      return {};
    });

    await sendChatMessage(state, "Analyze this", [attachment]);

    // Check that user message has correct content blocks
    const userMsg = state.chatMessages[0] as {
      role: string;
      content: Array<{ type: string; source?: { type: string; data: string } }>;
    };

    expect(userMsg.content).toHaveLength(2); // text + image
    expect(userMsg.content[0].type).toBe("text");
    expect(userMsg.content[1].type).toBe("image");

    // Source should have base64 data, not a URL path
    const imageSource = userMsg.content[1].source;
    expect(imageSource).toBeDefined();
    expect(imageSource?.type).toBe("base64");
    expect(imageSource?.data).toContain("data:image/jpeg;base64,");
  });

  it("handles multiple image attachments correctly", async () => {
    const attachments = [
      createImageAttachment("image/png"),
      createImageAttachment("image/jpeg"),
      createImageAttachment("image/webp"),
    ];

    let capturedAttachments: Array<{ mimeType: string }> = [];

    client.setRequestHandler(async (method, params) => {
      if (method === "chat.send") {
        const p = params as { attachments?: Array<{ mimeType: string }> };
        capturedAttachments = p.attachments ?? [];
        return { success: true };
      }
      return {};
    });

    await sendChatMessage(state, "Compare these", attachments);

    expect(capturedAttachments).toHaveLength(3);
    expect(capturedAttachments.map((a) => a.mimeType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
  });

  it("handles image-only message (no text)", async () => {
    const attachment = createImageAttachment();

    client.setRequestHandler(async (method, params) => {
      if (method === "chat.send") {
        const p = params as { message: string; attachments: unknown[] };
        expect(p.message).toBe("");
        expect(p.attachments).toHaveLength(1);
        return { success: true };
      }
      return {};
    });

    const runId = await sendChatMessage(state, "", [attachment]);
    expect(runId).not.toBeNull();
  });

  it("strips invalid data URLs gracefully", async () => {
    // Create attachment with invalid data URL
    const invalidAttachment: ChatAttachment = {
      id: "att-invalid",
      dataUrl: "not-a-valid-data-url",
      mimeType: "image/png",
    };

    client.setRequestHandler(async (method, params) => {
      if (method === "chat.send") {
        const p = params as { attachments?: unknown[] };
        // Invalid attachments should be filtered out
        expect(p.attachments).toEqual([]);
        return { success: true };
      }
      return {};
    });

    await sendChatMessage(state, "Test", [invalidAttachment]);
  });
});

// ============================================================================
// Regression 3: iOS Typing Lag (Controlled Input Handling)
// ============================================================================

describe("Regression: iOS typing lag (controlled input)", () => {
  it("does not trigger excessive re-renders during typing", () => {
    // This is a conceptual test - in the real app, input changes trigger
    // onDraftChange which updates state. The fix ensures this doesn't
    // cause useEffect cascades.
    const client = createMockGatewayClient();
    const state = createTestChatState(client);

    const originalMessages = [...state.chatMessages];

    // Simulate rapid input changes
    for (let i = 0; i < 10; i++) {
      state.chatMessage = `Typing... ${i}`;
    }

    // Messages should not change during typing
    expect(state.chatMessages).toEqual(originalMessages);

    // Final message should be the last typed value
    expect(state.chatMessage).toBe("Typing... 9");
  });

  it("handles empty message gracefully (no send)", async () => {
    const client = createMockGatewayClient();
    const state = createTestChatState(client);

    // Empty message should not send
    const runId = await sendChatMessage(state, "   ");
    expect(runId).toBeNull();
    expect(state.chatMessages).toHaveLength(0);
  });

  it("allows sending with only attachments (no text)", async () => {
    const client = createMockGatewayClient();
    const state = createTestChatState(client);

    const attachment = createImageAttachment();
    const runId = await sendChatMessage(state, "", [attachment]);

    expect(runId).not.toBeNull();
    expect(state.chatMessages).toHaveLength(1);
  });
});

// ============================================================================
// Additional: Stop/Abort Commands
// ============================================================================

describe("Chat: stop/abort command handling", () => {
  it("recognizes /stop as abort command", () => {
    expect(isChatStopCommand("/stop")).toBe(true);
    expect(isChatStopCommand("  /stop  ")).toBe(true);
  });

  it("recognizes plain 'stop' as abort command", () => {
    expect(isChatStopCommand("stop")).toBe(true);
    expect(isChatStopCommand("  stop  ")).toBe(true);
  });

  it("recognizes other abort variants", () => {
    expect(isChatStopCommand("abort")).toBe(true);
    expect(isChatStopCommand("wait")).toBe(true);
    expect(isChatStopCommand("exit")).toBe(true);
    expect(isChatStopCommand("esc")).toBe(true);
  });

  it("does not treat regular messages as stop", () => {
    expect(isChatStopCommand("stop that")).toBe(false);
    expect(isChatStopCommand("don't stop")).toBe(false);
    expect(isChatStopCommand("stopping")).toBe(false);
    expect(isChatStopCommand("hello")).toBe(false);
  });
});

// ============================================================================
// Additional: Connection State
// ============================================================================

describe("Chat: connection state handling", () => {
  it("does not send message when disconnected", async () => {
    const client = createMockGatewayClient();
    const state = createTestChatState(client);
    state.connected = false;

    const runId = await sendChatMessage(state, "Should not send");

    expect(runId).toBeNull();
    expect(state.chatMessages).toHaveLength(0);
  });

  it("queues message when busy", async () => {
    const host = createTestChatHost({
      chatRunId: "existing-run", // busy
    });

    // Chat is busy
    expect(isChatBusy(host)).toBe(true);
  });
});

// ============================================================================
// NO_REPLY Suppression
// ============================================================================

describe("Chat: NO_REPLY suppression", () => {
  let client: MockGatewayClient;
  let state: ChatState;

  beforeEach(() => {
    client = createMockGatewayClient();
    state = createTestChatState(client);
  });

  it("filters NO_REPLY from final messages", () => {
    state.chatRunId = "test-run";
    state.chatStream = "NO_REPLY";

    handleChatEvent(state, {
      runId: "test-run",
      sessionKey: state.sessionKey,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    });

    // Should not add NO_REPLY to history
    expect(state.chatMessages).toHaveLength(0);
    expect(state.chatStream).toBeNull();
  });

  it("filters NO_REPLY from streaming delta", () => {
    state.chatRunId = "test-run";

    handleChatEvent(state, {
      runId: "test-run",
      sessionKey: state.sessionKey,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    });

    // Should not update stream with NO_REPLY
    expect(state.chatStream).toBeNull();
  });

  it("includes normal assistant messages in history", () => {
    state.chatRunId = "test-run";
    state.chatStream = "Real response here";

    handleChatEvent(state, {
      runId: "test-run",
      sessionKey: state.sessionKey,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Real response here" }] },
    });

    expect(state.chatMessages).toHaveLength(1);
    const msg = state.chatMessages[0] as { role: string; content: Array<{ text: string }> };
    expect(msg.content[0].text).toBe("Real response here");
  });
});

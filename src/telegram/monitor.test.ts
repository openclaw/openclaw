/**
 * Tests for Telegram monitor
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Provider } from "../providers/base/interface.js";
import type {
  MessageHandler,
  ProviderMessage,
} from "../providers/base/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { monitorTelegramProvider } from "./monitor.js";

// Mock dependencies
vi.mock("../env.js", () => ({
  readEnv: vi.fn(() => ({
    accountSid: "test-sid",
    whatsappFrom: "+1234567890",
    auth: { accountSid: "test-sid", authToken: "test-token" },
    telegram: {
      apiId: 12345,
      apiHash: "test-hash",
    },
  })),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    inbound: {
      allowFrom: ["@testuser"],
      reply: {
        mode: "text",
        text: "Auto-reply test",
      },
    },
  })),
}));

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: vi.fn(async () => ({
    text: "Test reply",
  })),
}));

vi.mock("../providers/factory.js", () => ({
  createInitializedProvider: vi.fn(),
}));

describe("monitorTelegramProvider", () => {
  let mockRuntime: RuntimeEnv;
  let mockProvider: Provider;
  let messageHandler: MessageHandler | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    messageHandler = null;

    mockRuntime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      env: {},
    };

    mockProvider = {
      kind: "telegram",
      capabilities: {
        supportsDeliveryReceipts: false,
        supportsReadReceipts: false,
        supportsTypingIndicator: true,
        supportsReactions: false,
        supportsReplies: true,
        supportsEditing: true,
        supportsDeleting: true,
        maxMediaSize: 50 * 1024 * 1024,
        supportedMediaTypes: ["image", "video", "audio", "document"],
        canInitiateConversation: true,
      },
      initialize: vi.fn(),
      isConnected: vi.fn(() => true),
      disconnect: vi.fn(),
      send: vi.fn(async () => ({
        messageId: "msg-123",
        status: "sent" as const,
      })),
      sendTyping: vi.fn(),
      getDeliveryStatus: vi.fn(async () => ({
        messageId: "msg-123",
        status: "unknown" as const,
        timestamp: Date.now(),
      })),
      onMessage: vi.fn((handler: MessageHandler) => {
        messageHandler = handler;
      }),
      startListening: vi.fn(),
      stopListening: vi.fn(),
      isAuthenticated: vi.fn(async () => true),
      login: vi.fn(),
      logout: vi.fn(),
      getSessionId: vi.fn(async () => "@testuser"),
    };

    const { createInitializedProvider } = await import(
      "../providers/factory.js"
    );
    (createInitializedProvider as Mock).mockResolvedValue(mockProvider);
  });

  it("should throw if Telegram is not configured", async () => {
    const { readEnv } = await import("../env.js");
    (readEnv as Mock).mockReturnValueOnce({
      accountSid: "test-sid",
      whatsappFrom: "+1234567890",
      auth: { accountSid: "test-sid", authToken: "test-token" },
      // No telegram config
    });

    await expect(monitorTelegramProvider(false, mockRuntime)).rejects.toThrow(
      "Telegram not configured",
    );
  });

  it("should create and initialize provider with correct config", async () => {
    const { createInitializedProvider } = await import(
      "../providers/factory.js"
    );

    // Mock startListening to return immediately for test
    (mockProvider.startListening as Mock).mockImplementationOnce(async () => {
      // Immediately resolve to avoid hanging
    });

    // Start monitor in background
    const _monitorPromise = monitorTelegramProvider(true, mockRuntime);

    // Wait a bit for initialization
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(createInitializedProvider).toHaveBeenCalledWith("telegram", {
      kind: "telegram",
      apiId: 12345,
      apiHash: "test-hash",
      sessionDir: undefined,
      allowFrom: ["@testuser"],
      verbose: true,
    });

    expect(mockProvider.onMessage).toHaveBeenCalled();
    expect(mockProvider.startListening).toHaveBeenCalled();

    // monitorPromise will hang indefinitely, but we've verified the setup
  });

  it("should register message handler and handle inbound messages", async () => {
    const { getReplyFromConfig } = await import("../auto-reply/reply.js");

    // Mock startListening to call handler with test message
    (mockProvider.startListening as Mock).mockImplementationOnce(async () => {
      // Simulate receiving a message
      if (messageHandler) {
        const testMessage: ProviderMessage = {
          id: "test-msg-123",
          from: "@testuser",
          to: "@botuser",
          body: "Hello bot",
          timestamp: Date.now(),
          provider: "telegram",
        };
        await messageHandler(testMessage);
      }
    });

    // Start monitor
    const _monitorPromise = monitorTelegramProvider(false, mockRuntime);

    // Wait for message to be processed
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify reply was requested
    expect(getReplyFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        Body: "Hello bot",
        From: "@testuser",
        To: "@botuser",
      }),
      expect.objectContaining({
        onReplyStart: expect.any(Function),
      }),
      expect.anything(),
    );

    // Verify reply was sent
    expect(mockProvider.send).toHaveBeenCalledWith(
      "@testuser",
      "Test reply",
      expect.anything(),
    );

    // monitorPromise will hang, but we've verified message handling
  });

  it("should filter messages based on allowFrom config", async () => {
    const { loadConfig } = await import("../config/config.js");
    const { getReplyFromConfig } = await import("../auto-reply/reply.js");

    // Set allowFrom filter
    (loadConfig as Mock).mockReturnValueOnce({
      inbound: {
        allowFrom: ["@alloweduser"],
        reply: {
          mode: "text",
          text: "Auto-reply test",
        },
      },
    });

    // Mock startListening to call handler with message from non-allowed user
    (mockProvider.startListening as Mock).mockImplementationOnce(async () => {
      if (messageHandler) {
        const testMessage: ProviderMessage = {
          id: "test-msg-123",
          from: "@notallowed",
          to: "@botuser",
          body: "Hello",
          timestamp: Date.now(),
          provider: "telegram",
        };
        await messageHandler(testMessage);
      }
    });

    // Start monitor
    const _monitorPromise = monitorTelegramProvider(true, mockRuntime);

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify reply was NOT attempted (filtered out)
    expect(getReplyFromConfig).not.toHaveBeenCalled();
    expect(mockProvider.send).not.toHaveBeenCalled();
  });

  it("should handle media messages", async () => {
    const { getReplyFromConfig } = await import("../auto-reply/reply.js");

    // Mock reply with media
    (getReplyFromConfig as Mock).mockResolvedValueOnce({
      text: "Here's an image",
      mediaUrl: "https://example.com/image.jpg",
    });

    // Mock startListening to send message with media
    (mockProvider.startListening as Mock).mockImplementationOnce(async () => {
      if (messageHandler) {
        const testMessage: ProviderMessage = {
          id: "test-msg-456",
          from: "@testuser",
          to: "@botuser",
          body: "Send me a picture",
          timestamp: Date.now(),
          provider: "telegram",
          media: [
            {
              type: "image",
              url: "https://example.com/input.jpg",
              mimeType: "image/jpeg",
            },
          ],
        };
        await messageHandler(testMessage);
      }
    });

    // Start monitor
    const _monitorPromise = monitorTelegramProvider(false, mockRuntime);

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify reply with media was sent
    expect(mockProvider.send).toHaveBeenCalledWith(
      "@testuser",
      "Here's an image",
      expect.objectContaining({
        media: expect.arrayContaining([
          expect.objectContaining({
            type: "image",
            url: "https://example.com/image.jpg",
          }),
        ]),
      }),
    );
  });

  it("should send typing indicator when onReplyStart is called", async () => {
    const { getReplyFromConfig } = await import("../auto-reply/reply.js");
    let capturedOnReplyStart: (() => Promise<void>) | null = null;

    // Capture onReplyStart callback
    (getReplyFromConfig as Mock).mockImplementationOnce(async (_ctx, opts) => {
      capturedOnReplyStart = opts?.onReplyStart;
      return { text: "Test reply" };
    });

    // Mock startListening
    (mockProvider.startListening as Mock).mockImplementationOnce(async () => {
      if (messageHandler) {
        const testMessage: ProviderMessage = {
          id: "test-msg-789",
          from: "@testuser",
          to: "@botuser",
          body: "Hello",
          timestamp: Date.now(),
          provider: "telegram",
        };
        await messageHandler(testMessage);
      }
    });

    // Start monitor
    const _monitorPromise = monitorTelegramProvider(false, mockRuntime);

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Call captured onReplyStart
    if (capturedOnReplyStart) {
      await capturedOnReplyStart();
    }

    // Verify typing indicator was sent
    expect(mockProvider.sendTyping).toHaveBeenCalledWith("@testuser");
  });
});

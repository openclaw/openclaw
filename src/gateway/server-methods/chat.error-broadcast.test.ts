import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../types.js";

// Mock loadSessionEntry to throw a synchronous error
vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: vi.fn().mockImplementation(() => {
      throw Object.assign(new Error("LLM timeout"), { code: "TIMEOUT" });
    }),
  };
});

// Import chatHandlers AFTER the mock is set up
const { chatHandlers } = await import("./chat.js");

function createMockContext() {
  const broadcast = vi.fn();
  const nodeSendToSession = vi.fn();
  const chatAbortControllers = new Map();
  const chatRunSeq = new Map<string, number>();
  const dedupe = new Map();

  return {
    broadcast,
    nodeSendToSession,
    chatAbortControllers,
    chatRunSeq,
    dedupe,
    logGateway: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
  };
}

describe("chat.send error broadcast fix", () => {
  it("should broadcast error via broadcastChatError when synchronous error occurs", async () => {
    const ctx = createMockContext();
    const respond = vi.fn();

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "hello timeout-test",
        idempotencyKey: "test-run-1",
      },
      respond: respond as never,
      context: ctx as unknown as GatewayRequestContext,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
    });

    // Verify that respond was called with error
    expect(respond).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ runId: "test-run-1", status: "error" }),
      expect.any(Object),
      expect.any(Object),
    );

    // Verify that broadcastChatError was called (via context.broadcast)
    expect(ctx.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "test-run-1",
        state: "error",
        errorMessage: expect.stringContaining("LLM timeout"),
      }),
    );
  });
});

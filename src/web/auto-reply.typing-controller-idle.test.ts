import "./test-helpers.js";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { monitorWebChannel } from "./auto-reply.js";
import {
  createMockWebListener,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

describe("typing controller idle", () => {
  installWebAutoReplyUnitTestHooks();

  it("marks dispatch idle after replies flush", async () => {
    const markDispatchIdle = vi.fn();
    const typingMock = {
      onReplyStart: vi.fn(async () => {}),
      startTypingLoop: vi.fn(async () => {}),
      startTypingOnText: vi.fn(async () => {}),
      refreshTypingTtl: vi.fn(),
      isActive: vi.fn(() => false),
      markRunComplete: vi.fn(),
      markDispatchIdle,
      cleanup: vi.fn(),
    };
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    const replyResolver = vi.fn().mockImplementation(async (_ctx, opts) => {
      opts?.onTypingController?.(typingMock);
      return { text: "final reply" };
    });

    const mockConfig: OpenClawConfig = {
      channels: { whatsapp: { allowFrom: ["*"] } },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebChannel(
      false,
      async ({ onMessage }) => {
        await onMessage({
          id: "m1",
          from: "+1000",
          conversationId: "+1000",
          to: "+2000",
          body: "hello",
          timestamp: Date.now(),
          chatType: "direct",
          chatId: "direct:+1000",
          accountId: "default",
          sendComposing,
          reply,
          sendMedia,
        });
        return createMockWebListener();
      },
      false,
      replyResolver,
    );

    resetLoadConfigMock();

    expect(markDispatchIdle).toHaveBeenCalled();
  });
});

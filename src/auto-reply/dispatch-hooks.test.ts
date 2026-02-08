import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import type { MsgContext } from "./templating.js";
import * as internalHooks from "../hooks/internal-hooks.js";

// Use vi.hoisted to create mock before vi.mock hoisting
const { mockDispatchReplyFromConfig } = vi.hoisted(() => ({
  mockDispatchReplyFromConfig: vi.fn(),
}));

vi.mock("./reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: mockDispatchReplyFromConfig,
}));

// Import AFTER mock declaration
import { dispatchInboundMessage } from "./dispatch.js";

describe("dispatchInboundMessage hooks", () => {
  let triggerSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    triggerSpy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();
    mockDispatchReplyFromConfig.mockReset();
    mockDispatchReplyFromConfig.mockResolvedValue({ kind: "ok" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("triggers message:received hook for regular messages", async () => {
    const ctx: MsgContext = {
      Body: "Hello, this is a test message",
      From: "user123",
      SessionKey: "test-session",
      Surface: "telegram",
      ChatType: "direct",
      MessageSid: "msg-123",
    };

    const cfg = {} as OpenClawConfig;
    const dispatcher = {
      dispatch: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };

    await dispatchInboundMessage({
      ctx,
      cfg,
      dispatcher: dispatcher as unknown as ReplyDispatcher,
    });

    expect(triggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message",
        action: "received",
        sessionKey: "test-session",
        context: expect.objectContaining({
          body: "Hello, this is a test message",
          senderId: "user123",
          channel: "telegram",
        }),
      }),
    );
  });

  it("does not trigger message:received hook for commands", async () => {
    const ctx: MsgContext = {
      Body: "/new",
      From: "user123",
      SessionKey: "test-session",
    };

    const cfg = {} as OpenClawConfig;
    const dispatcher = {
      dispatch: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };

    await dispatchInboundMessage({
      ctx,
      cfg,
      dispatcher: dispatcher as unknown as ReplyDispatcher,
    });

    expect(triggerSpy).not.toHaveBeenCalled();
  });

  it("does not trigger message:received hook for commands via BodyForCommands", async () => {
    // Body looks normal, but BodyForCommands has a command
    const ctx: MsgContext = {
      Body: "some context text",
      BodyForCommands: "/status",
      From: "user123",
      SessionKey: "test-session",
    };

    const cfg = {} as OpenClawConfig;
    const dispatcher = {
      dispatch: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };

    await dispatchInboundMessage({
      ctx,
      cfg,
      dispatcher: dispatcher as unknown as ReplyDispatcher,
    });

    expect(triggerSpy).not.toHaveBeenCalled();
  });

  it("does not trigger for empty messages", async () => {
    const ctx: MsgContext = {
      Body: "",
      From: "user123",
      SessionKey: "test-session",
    };

    const cfg = {} as OpenClawConfig;
    const dispatcher = {
      dispatch: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    };

    await dispatchInboundMessage({
      ctx,
      cfg,
      dispatcher: dispatcher as unknown as ReplyDispatcher,
    });

    expect(triggerSpy).not.toHaveBeenCalled();
  });
});

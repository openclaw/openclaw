import { describe, expect, it, vi } from "vitest";
import { handleSlackMessageAction } from "./slack-message-actions.js";

function createInvokeSpy() {
  return vi.fn(async (action: Record<string, unknown>) => ({
    ok: true,
    content: action,
  }));
}

describe("handleSlackMessageAction", () => {
  it("falls back to toolContext.currentChannelId for react actions when target is omitted", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "react",
        cfg: {},
        params: {
          messageId: "123.456",
          emoji: "✅",
        },
        toolContext: {
          currentChannelId: "C123",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "react",
        channelId: "C123",
        messageId: "123.456",
        emoji: "✅",
      }),
      expect.any(Object),
    );
  });

  it("falls back to toolContext.currentChannelId for reactions actions when target is omitted", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "reactions",
        cfg: {},
        params: {
          messageId: "123.456",
        },
        toolContext: {
          currentChannelId: "C999",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "reactions",
        channelId: "C999",
        messageId: "123.456",
      }),
      expect.any(Object),
    );
  });

  it("does not resolve fallback for reactions when explicit target is missing and no context exists", async () => {
    const invoke = createInvokeSpy();

    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "react",
          cfg: {},
          params: {
            messageId: "123.456",
            emoji: "✅",
          },
        } as never,
        invoke: invoke as never,
      }),
    ).rejects.toThrow(/channelId required/);
  });

  it("maps download-file to the internal downloadFile action", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "download-file",
        cfg: {},
        params: {
          channelId: "C1",
          fileId: "F123",
          threadId: "111.222",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "downloadFile",
        fileId: "F123",
        channelId: "C1",
        threadId: "111.222",
      }),
      expect.any(Object),
    );
  });

  it("maps download-file target aliases to scope fields", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "download-file",
        cfg: {},
        params: {
          to: "channel:C2",
          fileId: "F999",
          replyTo: "333.444",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "downloadFile",
        fileId: "F999",
        channelId: "channel:C2",
        threadId: "333.444",
      }),
      expect.any(Object),
    );
  });
});

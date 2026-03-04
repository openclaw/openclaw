import { describe, expect, it, vi } from "vitest";
import { handleSlackMessageAction } from "./slack-message-actions.js";

function createInvokeSpy() {
  return vi.fn(async (action: Record<string, unknown>) => ({
    ok: true,
    content: action,
  }));
}

describe("handleSlackMessageAction", () => {
  it("maps read action with threadId to readMessages", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "read",
        cfg: {},
        params: {
          channelId: "C123",
          threadId: "123.456",
          limit: 10,
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "readMessages",
        channelId: "C123",
        threadId: "123.456",
        limit: 10,
      }),
      expect.any(Object),
    );
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

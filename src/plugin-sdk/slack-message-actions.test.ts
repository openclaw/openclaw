import { describe, expect, it, vi } from "vitest";
import { handleSlackMessageAction } from "./slack-message-actions.js";

describe("handleSlackMessageAction", () => {
  it("maps download-file to the internal downloadFile action", async () => {
    const invoke = vi.fn(async (action: Record<string, unknown>) => ({
      ok: true,
      content: action,
    }));

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "download-file",
        cfg: {},
        params: {
          channelId: "C1",
          fileId: "F123",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "downloadFile",
        fileId: "F123",
      }),
      expect.any(Object),
    );
  });
});

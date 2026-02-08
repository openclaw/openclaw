import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleDiscordMessageAction } from "./handle-action.js";

const handleDiscordAction = vi.fn(async () => ({ details: { ok: true } }));

vi.mock("../../../../agents/tools/discord-actions.js", () => ({
  handleDiscordAction: (...args: unknown[]) => handleDiscordAction(...args),
}));

describe("handleDiscordMessageAction", () => {
  beforeEach(() => {
    handleDiscordAction.mockClear();
  });

  it("forwards thread-create message as content", async () => {
    await handleDiscordMessageAction({
      action: "thread-create",
      params: {
        to: "channel:123456789",
        threadName: "Forum thread",
        message: "Initial forum post body",
      },
      cfg: {},
    });
    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "threadCreate",
        channelId: "123456789",
        name: "Forum thread",
        content: "Initial forum post body",
      }),
      expect.any(Object),
    );
  });
});

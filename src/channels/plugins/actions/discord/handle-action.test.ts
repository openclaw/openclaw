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

  it("forwards thread edit fields for channel-edit", async () => {
    await handleDiscordMessageAction({
      action: "channel-edit",
      params: {
        channelId: "123456789",
        archived: true,
        locked: false,
        autoArchiveDuration: 1440,
      },
      cfg: {},
    });
    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channelEdit",
        channelId: "123456789",
        archived: true,
        locked: false,
        autoArchiveDuration: 1440,
      }),
      expect.any(Object),
    );
  });
});

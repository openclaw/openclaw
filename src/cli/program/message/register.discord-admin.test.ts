import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageCliHelpers } from "./helpers.js";
import { registerMessageDiscordAdminCommands } from "./register.discord-admin.js";

function createHelpers(runMessageAction: MessageCliHelpers["runMessageAction"]): MessageCliHelpers {
  return {
    withMessageBase: (command) => command.option("--channel <channel>", "Channel"),
    withMessageTarget: (command) => command.option("-t, --target <dest>", "Target"),
    withRequiredMessageTarget: (command) => command.requiredOption("-t, --target <dest>", "Target"),
    runMessageAction,
  };
}

describe("registerMessageDiscordAdminCommands", () => {
  const runMessageAction = vi.fn(
    async (_action: string, _opts: Record<string, unknown>) => undefined,
  );

  beforeEach(() => {
    runMessageAction.mockClear();
  });

  it("registers channel create and routes args to channel-create", async () => {
    const message = new Command().exitOverride();
    registerMessageDiscordAdminCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(
      [
        "channel",
        "create",
        "--channel",
        "discord",
        "--guild-id",
        "guild-1",
        "--name",
        "test-channel",
        "--type",
        "0",
      ],
      { from: "user" },
    );

    expect(runMessageAction).toHaveBeenCalledWith(
      "channel-create",
      expect.objectContaining({
        channel: "discord",
        guildId: "guild-1",
        name: "test-channel",
        type: "0",
      }),
    );
  });

  it("registers channel edit and routes args to channel-edit", async () => {
    const message = new Command().exitOverride();
    registerMessageDiscordAdminCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(["channel", "edit", "--channel-id", "123", "--name", "renamed"], {
      from: "user",
    });

    expect(runMessageAction).toHaveBeenCalledWith(
      "channel-edit",
      expect.objectContaining({ channelId: "123", name: "renamed" }),
    );
  });

  it("registers channel delete and routes args to channel-delete", async () => {
    const message = new Command().exitOverride();
    registerMessageDiscordAdminCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(["channel", "delete", "--channel-id", "123"], { from: "user" });

    expect(runMessageAction).toHaveBeenCalledWith(
      "channel-delete",
      expect.objectContaining({ channelId: "123" }),
    );
  });

  it("registers channel move and routes args to channel-move", async () => {
    const message = new Command().exitOverride();
    registerMessageDiscordAdminCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(
      ["channel", "move", "--guild-id", "guild-1", "--channel-id", "123", "--position", "4"],
      {
        from: "user",
      },
    );

    expect(runMessageAction).toHaveBeenCalledWith(
      "channel-move",
      expect.objectContaining({ guildId: "guild-1", channelId: "123", position: "4" }),
    );
  });
});

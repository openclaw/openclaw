import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageCliHelpers } from "./helpers.js";
import { registerMessageThreadCommands } from "./register.thread.js";

function createHelpers(runMessageAction: MessageCliHelpers["runMessageAction"]): MessageCliHelpers {
  return {
    withMessageBase: (command) => command.option("--channel <channel>", "Channel"),
    withMessageTarget: (command) => command.option("-t, --target <dest>", "Target"),
    withRequiredMessageTarget: (command) => command.requiredOption("-t, --target <dest>", "Target"),
    runMessageAction,
  };
}

describe("registerMessageThreadCommands", () => {
  const runMessageAction = vi.fn(
    async (_action: string, _opts: Record<string, unknown>) => undefined,
  );

  beforeEach(() => {
    runMessageAction.mockClear();
  });

  it("routes Telegram thread create to topic-create with Telegram params", async () => {
    const message = new Command().exitOverride();
    registerMessageThreadCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(
      [
        "thread",
        "create",
        "--channel",
        " Telegram ",
        "-t",
        "-1001234567890",
        "--thread-name",
        "Build Updates",
        "-m",
        "hello",
      ],
      { from: "user" },
    );

    expect(runMessageAction).toHaveBeenCalledWith(
      "topic-create",
      expect.objectContaining({
        channel: " Telegram ",
        target: "-1001234567890",
        name: "Build Updates",
        message: "hello",
      }),
    );
    const telegramCall = runMessageAction.mock.calls.at(0);
    expect(telegramCall?.[1]).not.toHaveProperty("threadName");
  });

  it("keeps non-Telegram thread create on thread-create params", async () => {
    const message = new Command().exitOverride();
    registerMessageThreadCommands(message, createHelpers(runMessageAction));

    await message.parseAsync(
      [
        "thread",
        "create",
        "--channel",
        "discord",
        "-t",
        "channel:123",
        "--thread-name",
        "Build Updates",
        "-m",
        "hello",
      ],
      { from: "user" },
    );

    expect(runMessageAction).toHaveBeenCalledWith(
      "thread-create",
      expect.objectContaining({
        channel: "discord",
        target: "channel:123",
        threadName: "Build Updates",
        message: "hello",
      }),
    );
    const discordCall = runMessageAction.mock.calls.at(0);
    expect(discordCall?.[1]).not.toHaveProperty("name");
  });
});

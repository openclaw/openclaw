import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { MessageCliHelpers } from "./helpers.js";
import { registerMessageSendCommand } from "./register.send.js";

function createHelpers(runMessageAction = vi.fn(async () => undefined)): MessageCliHelpers {
  return {
    withMessageBase: (command) =>
      command
        .option("--channel <channel>", "Channel")
        .option("--json", "Output result as JSON", false)
        .option("--dry-run", "Print payload and skip sending", false)
        .option("--verbose", "Verbose logging", false),
    withMessageTarget: (command) => command.option("-t, --target <dest>", "Target"),
    withRequiredMessageTarget: (command) => command.requiredOption("-t, --target <dest>", "Target"),
    runMessageAction,
  };
}

describe("registerMessageSendCommand", () => {
  it("parses --as-voice and shows it in send help", async () => {
    const runMessageAction = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    const message = program.command("message");
    registerMessageSendCommand(message, createHelpers(runMessageAction));

    await program.parseAsync(
      ["message", "send", "--target", "room", "--media", "voice.mp3", "--as-voice"],
      { from: "user" },
    );

    expect(runMessageAction).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        target: "room",
        media: "voice.mp3",
        asVoice: true,
      }),
    );
    expect(
      message.commands.find((command) => command.name() === "send")?.helpInformation(),
    ).toContain("--as-voice");
  });
});

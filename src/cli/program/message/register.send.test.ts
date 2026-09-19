// Register send tests cover how message send media flags reach the shared send action.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { MessageCliHelpers } from "./helpers.js";
import { registerMessageSendCommand } from "./register.send.js";

function createSendProgram() {
  const program = new Command().name("openclaw").exitOverride();
  const runMessageAction = vi.fn(async () => undefined);
  const helpers: MessageCliHelpers = {
    withMessageBase: (command) => command.option("--channel <channel>"),
    withMessageTarget: (command) => command.option("-t, --target <target>"),
    withRequiredMessageTarget: (command) => command.requiredOption("-t, --target <target>"),
    runMessageAction,
  };
  registerMessageSendCommand(program.command("message"), helpers);
  return { program, runMessageAction };
}

describe("message send media options", () => {
  it.each([
    { name: "one --media value", args: ["--media", "./photo.jpg"], mediaUrls: ["./photo.jpg"] },
    {
      name: "repeated --media values in command-line order",
      args: [
        "--media",
        "./second.jpg",
        "--message",
        "Trip photos",
        "--media",
        "https://example.com/first.jpg",
        "--media",
        "./third.png",
      ],
      mediaUrls: ["./second.jpg", "https://example.com/first.jpg", "./third.png"],
    },
  ])("forwards $name to the send action", async ({ args, mediaUrls }) => {
    const { program, runMessageAction } = createSendProgram();

    await program.parseAsync(["message", "send", "--target", "123", ...args], { from: "user" });

    expect(runMessageAction).toHaveBeenCalledOnce();
    expect(runMessageAction).toHaveBeenCalledWith("send", expect.objectContaining({ mediaUrls }));
  });
});

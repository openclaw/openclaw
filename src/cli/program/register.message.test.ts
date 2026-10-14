import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";
import { registerMessageCommands } from "./register.message.js";

const { runMessageAction } = vi.hoisted(() => ({ runMessageAction: vi.fn(async () => {}) }));

vi.mock("./message/helpers.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./message/helpers.js")>();
  return {
    ...original,
    createMessageCliHelpers: (channelOptions: string) => ({
      ...original.createMessageCliHelpers(channelOptions),
      runMessageAction,
    }),
  };
});

const ctx: ProgramContext = {
  programVersion: "9.9.9-test",
  messageChannelOptions: "telegram|discord",
  agentChannelOptions: "last|telegram|discord",
};

function createProgram() {
  const program = new Command().exitOverride().configureOutput({ writeErr() {} });
  registerMessageCommands(program, ctx);
  return program;
}

describe("registerMessageCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the pinned resource id separately from the message id", async () => {
    await createProgram().parseAsync(
      [
        "message",
        "unpin",
        "--target",
        "conversation:123",
        "--message-id",
        "message-1",
        "--pinned-message-id",
        "resource-2",
        "--json",
      ],
      { from: "user" },
    );
    expect(runMessageAction).toHaveBeenCalledExactlyOnceWith("unpin", {
      target: "conversation:123",
      messageId: "message-1",
      pinnedMessageId: "resource-2",
      json: true,
      dryRun: false,
      verbose: false,
    });
  });

  it.each([undefined, "thread", "emoji", "sticker", "role", "channel", "member", "voice", "event"])(
    "shows message %s help without reporting a command failure",
    async (name) => {
      const program = createProgram();
      const message = program.commands.find((command) => command.name() === "message")!;
      const parent = name ? message.commands.find((command) => command.name() === name)! : message;
      const helpSpy = vi.spyOn(parent, "outputHelp").mockImplementation(() => {});
      const originalExitCode = process.exitCode;
      try {
        process.exitCode = undefined;
        await expect(
          program.parseAsync(["message", ...(name ? [name] : [])], { from: "user" }),
        ).resolves.toBe(program);
        expect(helpSpy).toHaveBeenCalledOnce();
        expect(process.exitCode).toBe(0);
        expect(runMessageAction).not.toHaveBeenCalled();
      } finally {
        process.exitCode = originalExitCode;
      }
    },
  );
});

import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";
import { registerMessageCommands } from "./register.message.js";

const mocks = vi.hoisted(() => ({
  registerMessageThreadCommandsMock: vi.fn(),
}));

function requireProgramCommand(program: Command, name: string): Command {
  const command = program.commands.find((entry) => entry.name() === name);
  if (!command) {
    throw new Error(`expected ${name} command`);
  }
  return command;
}

vi.mock("./message/helpers.js", () => ({
  createMessageCliHelpers: () => ({ helper: true }),
}));

vi.mock("./message/register.send.js", () => ({
  registerMessageSendCommand: vi.fn(),
}));

vi.mock("./message/register.broadcast.js", () => ({
  registerMessageBroadcastCommand: vi.fn(),
}));

vi.mock("./message/register.poll.js", () => ({
  registerMessagePollCommand: vi.fn(),
}));

vi.mock("./message/register.reactions.js", () => ({
  registerMessageReactionsCommands: vi.fn(),
}));

vi.mock("./message/register.read-edit-delete.js", () => ({
  registerMessageReadEditDeleteCommands: vi.fn(),
}));

vi.mock("./message/register.pins.js", () => ({
  registerMessagePinCommands: vi.fn(),
}));

vi.mock("./message/register.permissions-search.js", () => ({
  registerMessagePermissionsCommand: vi.fn(),
  registerMessageSearchCommand: vi.fn(),
}));

vi.mock("./message/register.thread.js", () => ({
  registerMessageThreadCommands: mocks.registerMessageThreadCommandsMock,
}));

vi.mock("./message/register.emoji-sticker.js", () => ({
  registerMessageEmojiCommands: vi.fn(),
  registerMessageStickerCommands: vi.fn(),
}));

vi.mock("./message/register.discord-admin.js", () => ({
  registerMessageDiscordAdminCommands: vi.fn(),
}));

describe("registerMessageCommands", () => {
  const ctx: ProgramContext = {
    programVersion: "9.9.9-test",
    messageChannelOptions: "telegram|discord",
    agentChannelOptions: "last|telegram|discord",
  };

  beforeEach(() => vi.clearAllMocks());

  it.each([undefined, "thread"])("shows parent help with success for %s", async (name) => {
    if (name) {
      mocks.registerMessageThreadCommandsMock.mockImplementationOnce((message: Command) => {
        message
          .command(name)
          .command("action")
          .action(() => {});
      });
    }
    const program = new Command().exitOverride();
    registerMessageCommands(program, ctx);
    const message = requireProgramCommand(program, "message");
    const parent = name ? requireProgramCommand(message, name) : message;
    const helpSpy = vi.spyOn(parent, "outputHelp").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await expect(
        program.parseAsync(["message", ...(name ? [name] : [])], { from: "user" }),
      ).resolves.toBe(program);
      expect(helpSpy).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

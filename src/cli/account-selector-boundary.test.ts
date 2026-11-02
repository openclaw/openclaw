import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerChannelsCli } from "./channels-cli.js";
import type { ProgramContext } from "./program/context.js";
import { registerMessageCommands } from "./program/register.message.js";

const context: ProgramContext = {
  programVersion: "test",
  messageChannelOptions: "discord",
  agentChannelOptions: "last|discord",
};

const cases = [
  {
    name: "message sticker send",
    args: ["message", "sticker", "send", "--target", "room", "--sticker-id", "sticker"],
  },
  { name: "channels capabilities", args: ["channels", "capabilities"] },
  { name: "channels resolve", args: ["channels", "resolve", "room"] },
];

async function createProgram(args: string[]) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
  if (args[0] === "message") {
    registerMessageCommands(program, context);
  } else {
    await registerChannelsCli(program, ["node", "openclaw", ...args]);
  }
  const startup = vi.fn((_root: Command, _action: Command) => {
    throw new Error("command startup reached");
  });
  program.hook("preAction", startup);
  return { program, startup };
}

describe("account selector option boundaries", () => {
  it.each(cases)("rejects blank input before $name startup", async ({ args }) => {
    const { program, startup } = await createProgram(args);
    await expect(program.parseAsync([...args, "--account", ""], { from: "user" })).rejects.toThrow(
      "--account must not be blank",
    );
    expect(startup).not.toHaveBeenCalled();
  });
});

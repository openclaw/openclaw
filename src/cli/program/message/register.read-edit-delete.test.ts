import type { Command } from "commander";
import { afterAll, describe, expect, it } from "vitest";
import {
  itWithFish,
  itWithPowerShell,
  PowerShellCompletionRunner,
  runGeneratedBashCompletion,
  runGeneratedFishCompletion,
} from "../../completion-cli.test-support.js";
import { createMessageCliProgram, messageCliMocks } from "./command.test-support.js";

const powerShellCompletion = new PowerShellCompletionRunner();
afterAll(async () => {
  await powerShellCompletion.close();
});

function createReadProgram() {
  const program = createMessageCliProgram("discord");
  const runMessageAction = messageCliMocks.command.mockClear();
  const message = program.commands.find((command) => command.name() === "message");
  if (!message) {
    throw new Error("Expected the message command");
  }
  return { program, message, runMessageAction };
}

describe("message read legacy option visibility", () => {
  it("keeps the shipped spelling accepted while forwarding supported read options", async () => {
    const { program, runMessageAction } = createReadProgram();
    await program.parseAsync(
      ["message", "read", "--target", "channel:123", "--include-thread", "--around", "42"],
      { from: "user" },
    );
    expect(runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "read",
        target: "channel:123",
        around: "42",
        includeThread: true,
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("rejects an unknown option at the same parser boundary", async () => {
    const { program, runMessageAction } = createReadProgram();
    await expect(
      program.parseAsync(["message", "read", "--target", "channel:123", "--unknown-read-option"], {
        from: "user",
      }),
    ).rejects.toMatchObject({ code: "commander.unknownOption" });
    expect(runMessageAction).not.toHaveBeenCalled();
  });

  it("shows supported read flags while omitting the inert spelling", () => {
    const { message } = createReadProgram();
    const read = message.commands.find((command) => command.name() === "read");
    expect(read).toBeDefined();
    const help = read!.helpInformation();
    expect(help).toContain("--around <id>");
    expect(help).toContain("--thread-id <id>");
    expect(help).not.toContain("--include-thread");
  });

  const engines = [
    {
      name: "Bash",
      test: it.skipIf(process.platform === "win32"),
      complete: (program: Command) =>
        runGeneratedBashCompletion(program, ["openclaw", "message", "read", "--"]),
    },
    {
      name: "Fish",
      test: itWithFish,
      complete: (program: Command) =>
        runGeneratedFishCompletion(program, "openclaw message read --"),
    },
    {
      name: "PowerShell",
      test: itWithPowerShell,
      complete: (program: Command) =>
        powerShellCompletion.complete(program, "openclaw message read --"),
    },
  ];
  for (const engine of engines) {
    engine.test(`hides the inert spelling from real ${engine.name} completions`, async () => {
      const completions = await engine.complete(createReadProgram().program);
      expect(completions).toContain("--around");
      expect(completions).toContain("--thread-id");
      expect(completions).not.toContain("--include-thread");
    });
  }
});

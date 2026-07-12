import { Readable } from "node:stream";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { readTeamsBootstrapPasswordFromStdin, registerTeamsCommand } from "./register.teams.js";

describe("teams CLI registration", () => {
  it("registers the bootstrap command with the safe credential flags", () => {
    const program = new Command();
    registerTeamsCommand(program);

    const teams = program.commands.find((command) => command.name() === "teams");
    const bootstrap = teams?.commands.find((command) => command.name() === "bootstrap");
    expect(bootstrap?.options.map((option) => option.long)).toEqual([
      "--login-label",
      "--password-stdin",
      "--domain-id",
    ]);
  });

  it("reads one non-TTY password line and removes only its line ending", async () => {
    const stdin = Readable.from(["  password with spaces  \r\n"]);
    Object.defineProperty(stdin, "isTTY", { configurable: true, value: false });

    await expect(readTeamsBootstrapPasswordFromStdin(stdin)).resolves.toBe(
      "  password with spaces  ",
    );
  });

  it("rejects terminal input and multiple password lines", async () => {
    const terminal = Readable.from(["password\n"]);
    Object.defineProperty(terminal, "isTTY", { configurable: true, value: true });
    await expect(readTeamsBootstrapPasswordFromStdin(terminal)).rejects.toThrow(/non-TTY stdin/i);

    const multipleLines = Readable.from(["first\nsecond\n"]);
    Object.defineProperty(multipleLines, "isTTY", { configurable: true, value: false });
    await expect(readTeamsBootstrapPasswordFromStdin(multipleLines)).rejects.toThrow(
      /exactly one line/i,
    );
  });
});

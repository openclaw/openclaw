import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCoreCliCommandNames = vi.hoisted(() => vi.fn(() => []));
const registerCoreCliByName = vi.hoisted(() => vi.fn(async () => {}));
const getProgramContext = vi.hoisted(() => vi.fn(() => null));
const getSubCliEntries = vi.hoisted(() => vi.fn(() => []));
const registerSubCliByName = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./program/command-registry.js", () => ({
  getCoreCliCommandNames,
  registerCoreCliByName,
}));

vi.mock("./program/program-context.js", () => ({
  getProgramContext,
}));

vi.mock("./program/register.subclis.js", () => ({
  getSubCliEntries,
  registerSubCliByName,
}));

import { registerCompletionCli } from "./completion-cli.js";

describe("registerCompletionCli", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
  });

  it("bootstraps zsh compinit before binding compdef", async () => {
    const program = new Command();
    program.name("openclaw");
    registerCompletionCli(program);

    await program.parseAsync(["completion", "--shell", "zsh"], { from: "user" });

    const output = stdoutWriteSpy.mock.calls
      .map((call: [unknown, ...unknown[]]) => String(call[0]))
      .join("");
    expect(output).toContain("autoload -Uz compinit");
    expect(output).toContain("compinit -i -C >/dev/null 2>&1");
    expect(output).toContain(
      "(( $+functions[compdef] )) && compdef _openclaw_root_completion openclaw",
    );
  });
});

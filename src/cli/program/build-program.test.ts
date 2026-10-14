// Build program tests cover root CLI program construction and command wiring.
import process from "node:process";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./build-program.js";
import type { ProgramContext } from "./context.js";

const registerCoreCliCommandsMock = vi.hoisted(() => vi.fn());
const registerSubCliCommandsMock = vi.hoisted(() => vi.fn());
const createProgramContextMock = vi.hoisted(() => vi.fn());
const configureProgramHelpMock = vi.hoisted(() => vi.fn());
const registerPreActionHooksMock = vi.hoisted(() => vi.fn());
const setProgramContextMock = vi.hoisted(() => vi.fn());

vi.mock("./command-registry-core.js", () => ({
  registerCoreCliCommands: registerCoreCliCommandsMock,
}));

vi.mock("./register.subclis.js", () => ({
  registerSubCliCommands: registerSubCliCommandsMock,
}));

vi.mock("./context.js", () => ({
  createProgramContext: createProgramContextMock,
}));

vi.mock("./help.js", () => ({
  configureProgramHelp: configureProgramHelpMock,
}));

vi.mock("./preaction.js", () => ({
  registerPreActionHooks: registerPreActionHooksMock,
}));

vi.mock("./program-context.js", () => ({
  setProgramContext: setProgramContextMock,
}));

describe("buildProgram", () => {
  function mockProcessOutput() {
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as unknown as typeof process.stdout.write,
    );
    vi.spyOn(process.stderr, "write").mockImplementation(
      (() => true) as unknown as typeof process.stderr.write,
    );
  }

  async function expectCommanderExit(promise: Promise<unknown>, exitCode: number) {
    const error = await promise.catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommanderError);
    expect((error as CommanderError).exitCode).toBe(exitCode);
    return error as CommanderError;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessOutput();
    createProgramContextMock.mockReturnValue({
      programVersion: "9.9.9-test",
      messageChannelOptions: "quietchat",
      agentChannelOptions: "last|quietchat",
    } satisfies ProgramContext);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("sets exitCode to 1 on argument errors (fixes #60905)", async () => {
    const program = buildProgram();
    program.command("test").description("Test command");

    const error = await expectCommanderExit(
      program.parseAsync(["test", "unexpected-arg"], { from: "user" }),
      1,
    );

    expect(error.code).toBe("commander.excessArguments");
    expect(process.exitCode).toBe(1);
  });

  it("preserves exitCode 0 for help display", async () => {
    const program = buildProgram();
    program.command("test").description("Test command");

    const error = await expectCommanderExit(program.parseAsync(["--help"], { from: "user" }), 0);

    expect(error.code).toBe("commander.helpDisplayed");
    expect(process.exitCode).toBe(0);
  });

  it("preserves caller-configured Commander error output", async () => {
    let stderr = "";
    const outputError = vi.fn((value: string, write: (value: string) => void) => {
      write(`custom: ${value}`);
    });
    const originalArgv = process.argv;
    const program = buildProgram().configureOutput({
      writeErr: (value) => {
        stderr += value;
      },
      outputError,
    });
    program.command("probe").action(() => {});
    process.argv = ["node", "openclaw", "probe", "--wat"];
    try {
      await expectCommanderExit(program.parseAsync(process.argv), 1);
    } finally {
      process.argv = originalArgv;
    }

    expect(outputError).toHaveBeenCalledOnce();
    expect(stderr).toContain("custom: error: unknown option '--wat'");
  });
});

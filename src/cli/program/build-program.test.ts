import process from "node:process";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./build-program.js";
import type { ProgramContext } from "./context.js";

const createProgramContextMock = vi.hoisted(() => vi.fn());
vi.mock("./command-registry-core.js", () => ({ registerCoreCliCommands: vi.fn() }));
vi.mock("./register.subclis.js", () => ({ registerSubCliCommands: vi.fn() }));
vi.mock("./context.js", () => ({ createProgramContext: createProgramContextMock }));
vi.mock("./help.js", () => ({ configureProgramHelp: vi.fn() }));
vi.mock("./preaction.js", () => ({ registerPreActionHooks: vi.fn() }));
vi.mock("./program-context.js", () => ({ setProgramContext: vi.fn() }));

describe("buildProgram", () => {
  async function expectCommanderExit(promise: Promise<unknown>, exitCode: number) {
    const error = await promise.catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommanderError);
    expect((error as CommanderError).exitCode).toBe(exitCode);
    return error as CommanderError;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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

import process from "node:process";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./build-program.js";
import type { ProgramContext } from "./context.js";

const createProgramContextMock = vi.hoisted(() => vi.fn());
// mock-isolation: root argument handling must not load or execute real command handlers.
vi.mock("./command-registry-core.js", () => ({ registerCoreCliCommands: vi.fn() }));
// mock-isolation: root argument handling must not load optional subcommand runtimes.
vi.mock("./register.subclis.js", () => ({ registerSubCliCommands: vi.fn() }));
// mock-isolation: use fixed version and channel context, not installed runtime metadata.
vi.mock("./context.js", () => ({ createProgramContext: createProgramContextMock }));
// mock-isolation: exercise Commander error routing without global help customization.
vi.mock("./help.js", () => ({ configureProgramHelp: vi.fn() }));
// mock-isolation: argument-error tests must not admit real command side effects.
vi.mock("./preaction.js", () => ({ registerPreActionHooks: vi.fn() }));
// mock-isolation: keep the program context local to this synthetic CLI fixture.
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

  it.each([
    { args: ["test", "unexpected-arg"], exitCode: 1, code: "commander.excessArguments" },
    { args: ["--help"], exitCode: 0, code: "commander.helpDisplayed" },
  ])("preserves $code exit status (regression #60905)", async ({ args, exitCode, code }) => {
    const program = buildProgram();
    program.command("test").description("Test command");
    const error = await expectCommanderExit(program.parseAsync(args, { from: "user" }), exitCode);
    expect(error.code).toBe(code);
    expect(process.exitCode).toBe(exitCode);
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

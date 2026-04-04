import process from "node:process";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./build-program.js";
import type { ProgramContext } from "./context.js";

const registerProgramCommandsMock = vi.hoisted(() => vi.fn());
const createProgramContextMock = vi.hoisted(() => vi.fn());
const configureProgramHelpMock = vi.hoisted(() => vi.fn());
const registerPreActionHooksMock = vi.hoisted(() => vi.fn());
const setProgramContextMock = vi.hoisted(() => vi.fn());

vi.mock("./command-registry.js", () => ({
  registerProgramCommands: registerProgramCommandsMock,
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
  beforeEach(() => {
    vi.clearAllMocks();
    createProgramContextMock.mockReturnValue({
      programVersion: "9.9.9-test",
      channelOptions: ["telegram"],
      messageChannelOptions: "telegram",
      agentChannelOptions: "last|telegram",
    } satisfies ProgramContext);
  });

  afterEach(() => {
    // Clean up exitCode after each test
    process.exitCode = undefined;
  });

  it("wires context/help/preaction/command registration with shared context", () => {
    const argv = ["node", "openclaw", "status"];
    const originalArgv = process.argv;
    process.argv = argv;
    try {
      const program = buildProgram();
      const ctx = createProgramContextMock.mock.results[0]?.value as ProgramContext;

      expect(program).toBeInstanceOf(Command);
      expect(setProgramContextMock).toHaveBeenCalledWith(program, ctx);
      expect(configureProgramHelpMock).toHaveBeenCalledWith(program, ctx);
      expect(registerPreActionHooksMock).toHaveBeenCalledWith(program, ctx.programVersion);
      expect(registerProgramCommandsMock).toHaveBeenCalledWith(program, ctx, argv);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("sets exitCode to 1 on argument errors (fixes #60905)", () => {
    // Reset exitCode before test
    process.exitCode = undefined;
    const program = buildProgram();
    program.command("test").description("Test command");

    // Simulate argument error: passing unexpected argument to command that doesn't accept any
    try {
      program.parse(["node", "openclaw", "test", "unexpected-arg"], { from: "user" });
    } catch {
      // exitOverride throws, but we expect exitCode to be set
    }

    expect(process.exitCode).toBe(1);
  });

  it("preserves exitCode 0 for help display", () => {
    // Reset exitCode before test
    process.exitCode = undefined;
    const program = buildProgram();
    program.command("test").description("Test command");

    try {
      program.parse(["node", "openclaw", "--help"], { from: "user" });
    } catch {
      // exitOverride throws for help too
    }

    expect(process.exitCode).toBe(0);
  });

  it("preserves exitCode 0 for version display", () => {
    // Reset exitCode before test
    process.exitCode = undefined;
    const program = buildProgram();
    program.version("1.0.0");

    try {
      program.parse(["node", "openclaw", "--version"], { from: "user" });
    } catch {
      // exitOverride throws for version too
    }

    expect(process.exitCode).toBe(0);
  });
});

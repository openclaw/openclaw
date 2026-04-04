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
  function mockProcessExit() {
    return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);
  }

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
    process.exitCode = undefined;
    vi.restoreAllMocks();
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

  it("sets exitCode to 1 on argument errors (fixes #60905)", async () => {
    const program = buildProgram();
    const exitSpy = mockProcessExit();
    program.command("test").description("Test command");

    await expect(program.parseAsync(["test", "unexpected-arg"], { from: "user" })).rejects.toThrow(
      "process.exit:1",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(process.exitCode).toBe(1);
  });

  it("does not run the command action after an argument error", async () => {
    const program = buildProgram();
    const exitSpy = mockProcessExit();
    const actionSpy = vi.fn();
    program.command("test").action(actionSpy);

    await expect(program.parseAsync(["test", "unexpected-arg"], { from: "user" })).rejects.toThrow(
      "process.exit:1",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(actionSpy).not.toHaveBeenCalled();
  });

  it("preserves exitCode 0 for help display", async () => {
    const program = buildProgram();
    const exitSpy = mockProcessExit();
    program.command("test").description("Test command");

    await expect(program.parseAsync(["--help"], { from: "user" })).rejects.toThrow(
      "process.exit:0",
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(process.exitCode).toBe(0);
  });

  it("preserves exitCode 0 for version display", async () => {
    const program = buildProgram();
    const exitSpy = mockProcessExit();
    program.version("1.0.0");

    await expect(program.parseAsync(["--version"], { from: "user" })).rejects.toThrow(
      "process.exit:0",
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(process.exitCode).toBe(0);
  });

  it("preserves non-zero exitCode for help error flows", async () => {
    const program = buildProgram();
    const exitSpy = mockProcessExit();
    program.helpCommand("help [command]");

    await expect(program.parseAsync(["help", "missing"], { from: "user" })).rejects.toThrow(
      "process.exit:1",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(process.exitCode).toBe(1);
  });
});

import process from "node:process";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";

const registerProgramCommandsMock = vi.fn();
const createProgramContextMock = vi.fn();
const configureProgramHelpMock = vi.fn();
const registerPreActionHooksMock = vi.fn();
const setProgramContextMock = vi.fn();

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

const { buildProgram } = await import("./build-program.js");

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
});

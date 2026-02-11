import { Command } from "commander";
import { describe, expect, it } from "vitest";

describe("command-stubs", () => {
  it("lists the same commands as full registration", async () => {
    const { registerStubCommands } = await import("./command-stubs.js");
    const { registerProgramCommands } = await import("./command-registry.js");

    const fullProgram = new Command();
    await registerProgramCommands(fullProgram, { agentChannelOptions: "" } as Parameters<
      typeof registerProgramCommands
    >[1]);
    const fullNames = fullProgram.commands
      .map((c) => c.name())
      .filter((n) => n !== "help")
      .toSorted();

    const stubProgram = new Command();
    registerStubCommands(stubProgram);
    const stubNames = stubProgram.commands
      .map((c) => c.name())
      .filter((n) => n !== "help")
      .toSorted();

    expect(stubNames).toEqual(fullNames);
  });
});

import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";

// Keep lazy imports focused on registry wiring, not the heavy registrars.
function registerNames(program: Command, ...names: string[]) {
  for (const name of names) {
    program.command(name);
  }
}
// mock-isolation: registry wiring must not query live Gateway or session state.
vi.mock("./register.status-health-sessions.js", () => ({
  registerStatusHealthSessionsCommands: (program: Command) =>
    registerNames(program, "status", "health", "sessions"),
}));

import { registerCoreCliCommands } from "./command-registry-core.js";
import { getCoreCliCommandNamesCore } from "./core-command-descriptors.js";

const testProgramContext: ProgramContext = {
  programVersion: "0.0.0-test",
  messageChannelOptions: "",
  agentChannelOptions: "web",
};

describe("command-registry", () => {
  const namesOf = (program: Command) => program.commands.map((command) => command.name());

  it("includes both agent and agents in core CLI command names", () => {
    const names = getCoreCliCommandNamesCore();
    expect(names).toEqual(
      expect.arrayContaining(["setup", "crestodian", "mcp", "agent", "agents"]),
    );
    expect(names).not.toContain("tasks");
  });

  it("exposes Templates without a process opt-in", () => {
    expect(getCoreCliCommandNamesCore()).toContain("templates");
    expect(getCoreCliCommandNamesCore()).not.toContain("claws");
  });

  it("registers grouped core entry placeholders without duplicate command errors", async () => {
    const program = new Command();
    registerCoreCliCommands(program, testProgramContext, ["node", "openclaw", "vitest"]);
    program.exitOverride();
    await program.parseAsync(["node", "openclaw", "status"]);

    const names = namesOf(program);
    expect(names).toEqual(expect.arrayContaining(["status", "health", "sessions"]));
    expect(names).not.toContain("tasks");
  });
});

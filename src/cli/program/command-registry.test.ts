import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";

// Keep lazy imports focused on registry wiring, not the heavy registrars.
function registerNames(program: Command, ...names: string[]) {
  for (const name of names) {
    program.command(name);
  }
}
vi.mock("./register.agent.js", () => ({
  registerAgentsCommands: (program: Command) => registerNames(program, "agents"),
}));
vi.mock("./register.agent-turn.js", () => ({
  registerAgentTurnCommand: (program: Command) => registerNames(program, "agent"),
}));
vi.mock("./register.maintenance.js", () => ({
  registerMaintenanceCommands: (program: Command) =>
    registerNames(program, "doctor", "triage", "dashboard", "reset", "uninstall"),
}));
vi.mock("./register.status-health-sessions.js", () => ({
  registerStatusHealthSessionsCommands: (program: Command) =>
    registerNames(program, "status", "health", "sessions"),
}));

import { registerCoreCliByName, registerCoreCliCommands } from "./command-registry-core.js";
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

  it("exposes Claws without a process opt-in", () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    expect(getCoreCliCommandNamesCore()).toContain("claws");

    vi.unstubAllEnvs();
  });

  it("registerCoreCliByName resolves agent and agents separately", async () => {
    const program = new Command();
    const found = await registerCoreCliByName(program, testProgramContext, "agents");
    expect(found).toBe(true);
    expect(namesOf(program)).toEqual(["agents"]);

    const agentProgram = new Command();
    expect(await registerCoreCliByName(agentProgram, testProgramContext, "agent")).toBe(true);
    expect(namesOf(agentProgram)).toEqual(["agent"]);
  });

  it.each(["tasks"])("registerCoreCliByName returns false for %s", async (name) => {
    const program = new Command();
    const found = await registerCoreCliByName(program, testProgramContext, name);
    expect(found).toBe(false);
    expect(namesOf(program)).toEqual([]);
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

  it("replaces placeholders when loading a grouped entry by secondary command name", async () => {
    const program = new Command();
    registerCoreCliCommands(program, testProgramContext, ["node", "openclaw", "doctor"]);
    expect(namesOf(program)).toEqual(["doctor"]);

    const found = await registerCoreCliByName(program, testProgramContext, "dashboard");
    expect(found).toBe(true);
    expect(namesOf(program)).toEqual(["doctor", "triage", "dashboard", "reset", "uninstall"]);
  });
});

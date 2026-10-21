// Command registry tests cover CLI command descriptor registry behavior.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";

// Perf: `registerCoreCliByName(...)` dynamically imports registrar modules.
// Mock the heavy registrars so this suite stays focused on command-registry wiring.
vi.mock("./register.agent.js", () => ({
  registerAgentsCommands: (program: Command) => {
    program.command("agents");
  },
}));

vi.mock("./register.agent-turn.js", () => ({
  registerAgentTurnCommand: (program: Command) => {
    program.command("agent");
  },
}));

vi.mock("./register.backup.js", () => ({
  registerBackupCommand: (program: Command) => {
    const backup = program.command("backup");
    backup.command("create");
  },
}));

vi.mock("./register.maintenance.js", () => ({
  registerMaintenanceCommands: (program: Command) => {
    program.command("doctor");
    program.command("triage");
    program.command("dashboard");
    program.command("reset");
    program.command("uninstall");
  },
}));

vi.mock("./register.status-health-sessions.js", () => ({
  registerStatusHealthSessionsCommands: (program: Command) => {
    program.command("status");
    program.command("health");
    program.command("sessions");
  },
}));

vi.mock("./register.setup.js", () => ({
  registerSetupCommand: (program: Command) => {
    program.command("setup");
    program.command("crestodian", { hidden: true }); // hidden alias
  },
}));

import { registerCoreCliByName, registerCoreCliCommands } from "./command-registry-core.js";
import { getCoreCliCommandNamesCore } from "./core-command-descriptors.js";

const testProgramContext: ProgramContext = {
  programVersion: "0.0.0-test",
  messageChannelOptions: "",
  agentChannelOptions: "web",
};

describe("command-registry", () => {
  const createProgram = () => new Command();
  const namesOf = (program: Command) => program.commands.map((command) => command.name());

  const withProcessArgv = async (argv: string[], run: () => Promise<void>) => {
    const prevArgv = process.argv;
    process.argv = argv;
    try {
      await run();
    } finally {
      process.argv = prevArgv;
    }
  };

  it("includes both agent and agents in core CLI command names", () => {
    const names = getCoreCliCommandNamesCore();
    expect(names).toContain("setup");
    expect(names).toContain("crestodian"); // hidden alias
    expect(names).toContain("mcp");
    expect(names).toContain("agent");
    expect(names).toContain("agents");
    expect(names).not.toContain("tasks");
  });

  it("exposes Claws without a process opt-in", () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    expect(getCoreCliCommandNamesCore()).toContain("claws");

    vi.unstubAllEnvs();
  });

  it("registerCoreCliByName resolves agent and agents separately", async () => {
    const program = createProgram();
    const found = await registerCoreCliByName(program, testProgramContext, "agents");
    expect(found).toBe(true);
    expect(program.commands.map((command) => command.name())).toEqual(["agents"]);

    const agentProgram = createProgram();
    await expect(registerCoreCliByName(agentProgram, testProgramContext, "agent")).resolves.toBe(
      true,
    );
    expect(agentProgram.commands.map((command) => command.name())).toEqual(["agent"]);
  });

  it.each(["tasks"])("registerCoreCliByName returns false for %s", async (name) => {
    const program = createProgram();
    const found = await registerCoreCliByName(program, testProgramContext, name);
    expect(found).toBe(false);
    expect(namesOf(program)).toEqual([]);
  });

  it("registers grouped core entry placeholders without duplicate command errors", async () => {
    const program = createProgram();
    registerCoreCliCommands(program, testProgramContext, ["node", "openclaw", "vitest"]);
    program.exitOverride();
    await withProcessArgv(["node", "openclaw", "status"], async () => {
      await program.parseAsync(["node", "openclaw", "status"]);
    });

    const names = namesOf(program);
    expect(names).toContain("status");
    expect(names).toContain("health");
    expect(names).toContain("sessions");
    expect(names).not.toContain("tasks");
  });

  it("replaces placeholders when loading a grouped entry by secondary command name", async () => {
    const program = createProgram();
    registerCoreCliCommands(program, testProgramContext, ["node", "openclaw", "doctor"]);
    expect(namesOf(program)).toEqual(["doctor"]);

    const found = await registerCoreCliByName(program, testProgramContext, "dashboard");
    expect(found).toBe(true);
    expect(namesOf(program)).toEqual(["doctor", "triage", "dashboard", "reset", "uninstall"]);
  });
});

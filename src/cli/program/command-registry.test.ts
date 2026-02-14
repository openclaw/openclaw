import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";
import {
  getCoreCliCommandNames,
  registerCoreCliByName,
  registerCoreCliCommands,
} from "./command-registry.js";

vi.mock("./register.status-health-sessions.js", () => ({
  registerStatusHealthSessionsCommands: (program: Command) => {
    program.command("status");
    program.command("health");
    program.command("sessions");
  },
}));

const testProgramContext: ProgramContext = {
  programVersion: "0.0.0-test",
  channelOptions: [],
  messageChannelOptions: "",
  agentChannelOptions: "web",
};

describe("command-registry", () => {
  it("includes both agent and agents in core CLI command names", () => {
    const names = getCoreCliCommandNames();
    expect(names).toContain("agent");
    expect(names).toContain("agents");
  });

  it("registerCoreCliByName resolves agents to the agent entry", async () => {
    const program = new Command();
    const found = await registerCoreCliByName(program, testProgramContext, "agents");
    expect(found).toBe(true);
    const agentsCmd = program.commands.find((c) => c.name() === "agents");
    expect(agentsCmd).toBeDefined();
    // The registrar also installs the singular "agent" command from the same entry.
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    expect(agentCmd).toBeDefined();
  });

  it("registerCoreCliByName returns false for unknown commands", async () => {
    const program = new Command();
    const found = await registerCoreCliByName(program, testProgramContext, "nonexistent");
    expect(found).toBe(false);
  });

  it("registers doctor placeholder for doctor primary command", () => {
    const program = new Command();
    registerCoreCliCommands(program, testProgramContext, ["node", "openclaw", "doctor"]);

    expect(program.commands.map((command) => command.name())).toEqual(["doctor"]);
  });

  it("treats maintenance commands as top-level builtins", async () => {
    const program = new Command();

    expect(await registerCoreCliByName(program, testProgramContext, "doctor")).toBe(true);

    const names = getCoreCliCommandNames();
    expect(names).toContain("doctor");
    expect(names).toContain("dashboard");
    expect(names).toContain("reset");
    expect(names).toContain("uninstall");
    expect(names).not.toContain("maintenance");
  });

  it("registers grouped core entry placeholders without duplicate command errors", async () => {
    const program = new Command();
    registerCoreCliCommands(program, testProgramContext, ["node", "openclaw", "vitest"]);

    const prevArgv = process.argv;
    process.argv = ["node", "openclaw", "status"];
    try {
      program.exitOverride();
      await program.parseAsync(["node", "openclaw", "status"]);
    } finally {
      process.argv = prevArgv;
    }

    const names = program.commands.map((command) => command.name());
    expect(names).toContain("status");
    expect(names).toContain("health");
    expect(names).toContain("sessions");
  });
});

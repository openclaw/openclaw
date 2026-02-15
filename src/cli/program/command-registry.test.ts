import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";

vi.mock("./register.agent.js", () => ({
  registerAgentCommands: (program: Command) => {
    program.command("agent");
    program.command("agents");
  },
}));

vi.mock("./register.maintenance.js", () => ({
  registerMaintenanceCommands: (program: Command) => {
    program.command("doctor");
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
  registerSetupCommand: (program: Command) => program.command("setup"),
}));

vi.mock("./register.onboard.js", () => ({
  registerOnboardCommand: (program: Command) => program.command("onboard"),
}));

vi.mock("./register.configure.js", () => ({
  registerConfigureCommand: (program: Command) => program.command("configure"),
}));

vi.mock("./register.message.js", () => ({
  registerMessageCommands: (program: Command) => program.command("message"),
}));

vi.mock("../../browser-cli.js", () => ({
  registerBrowserCli: (program: Command) => program.command("browser"),
}));

vi.mock("../../config-cli.js", () => ({
  registerConfigCli: (program: Command) => program.command("config"),
}));

vi.mock("../../memory-cli.js", () => ({
  registerMemoryCli: (program: Command) => program.command("memory"),
}));

vi.mock("./register.subclis.js", () => ({
  registerSubCliCommands: (program: Command) => program.command("subclis"),
}));

const { registerProgramCommands } = await import("./command-registry.js");

const testProgramContext: ProgramContext = {
  programVersion: "0.0.0-test",
  channelOptions: [],
  messageChannelOptions: "",
  agentChannelOptions: "web",
};

describe("command-registry", () => {
  it("registerProgramCommands registers all core commands", async () => {
    const program = new Command();
    await registerProgramCommands(program, testProgramContext);

    const names = program.commands.map((c) => c.name());
    expect(names).toContain("agent");
    expect(names).toContain("agents");
    expect(names).toContain("status");
    expect(names).toContain("doctor");
    expect(names).toContain("setup");
    expect(names).toContain("message");
    expect(names).toContain("config");
    expect(names).toContain("memory");
  });

  it("does not register duplicate commands", async () => {
    const program = new Command();
    await registerProgramCommands(program, testProgramContext);

    const names = program.commands.map((c) => c.name());
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });
});

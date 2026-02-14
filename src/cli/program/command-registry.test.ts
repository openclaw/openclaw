import { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { ProgramContext } from "./context.js";
import { getCoreCliCommandNames, registerCoreCliByName } from "./command-registry.js";

const stubCtx: ProgramContext = {
  programVersion: "0.0.0-test",
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
    const found = await registerCoreCliByName(program, stubCtx, "agents");
    expect(found).toBe(true);
    const agentsCmd = program.commands.find((c) => c.name() === "agents");
    expect(agentsCmd).toBeDefined();
    // The registrar also installs the singular "agent" command from the same entry
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    expect(agentCmd).toBeDefined();
  });

  it("registerCoreCliByName returns false for unknown commands", async () => {
    const program = new Command();
    const found = await registerCoreCliByName(program, stubCtx, "nonexistent");
    expect(found).toBe(false);
  });
});

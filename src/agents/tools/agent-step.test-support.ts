import { vi } from "vitest";

type AgentCommandRunner = typeof import("../../commands/agent.js").agentCommandFromIngress;
let restoreIngress: (() => void) | undefined;

export const testing = {
  async setDepsForTest(
    overrides?: Partial<{
      agentCommandFromIngress: AgentCommandRunner;
    }>,
  ): Promise<void> {
    restoreIngress?.();
    restoreIngress = undefined;
    if (!overrides?.agentCommandFromIngress) {
      return;
    }
    const command = await import("../../commands/agent.js");
    const spy = vi
      .spyOn(command, "agentCommandFromIngress")
      .mockImplementation(overrides.agentCommandFromIngress);
    restoreIngress = () => spy.mockRestore();
  },
};

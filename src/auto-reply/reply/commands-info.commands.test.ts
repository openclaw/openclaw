import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

async function loadCommandsHarness() {
  vi.resetModules();
  vi.doMock("../skill-commands.js", () => ({
    listSkillCommandsForAgents: () => [],
  }));
  const { buildCommandTestParams } = await import("./commands.test-harness.js");
  const { handleCommandsListCommand } = await import("./commands-info.js");
  return { buildCommandTestParams, handleCommandsListCommand };
}

function buildConfig() {
  return {
    commands: { text: true, config: false, debug: false },
    channels: { whatsapp: { allowFrom: ["*"] } },
  } as OpenClawConfig;
}

describe("handleCommandsListCommand", () => {
  it("includes current agent and workspace context in command replies", async () => {
    const { buildCommandTestParams, handleCommandsListCommand } = await loadCommandsHarness();
    const params = buildCommandTestParams("/commands", buildConfig(), undefined, {
      workspaceDir: "/tmp/openclaw-workspace-main",
    });
    params.agentId = "main";
    params.ctx = {
      ...params.ctx,
      Surface: "whatsapp",
      Provider: "whatsapp",
    };

    const result = await handleCommandsListCommand(params, true);

    expect(result?.reply?.text).toContain("Agent: main");
    expect(result?.reply?.text).toContain("Workspace: /tmp/openclaw-workspace-main");
    expect(result?.reply?.text).toContain("ℹ️ Slash commands");
    expect(result?.reply?.text).toContain("/tools - List available runtime tools.");
  });

  it("ignores unauthorized senders", async () => {
    const { buildCommandTestParams, handleCommandsListCommand } = await loadCommandsHarness();
    const params = buildCommandTestParams("/commands", buildConfig(), undefined, {
      workspaceDir: "/tmp/openclaw-workspace-main",
    });
    params.command = {
      ...params.command,
      isAuthorizedSender: false,
      senderId: "unauthorized",
    };

    const result = await handleCommandsListCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
  });
});

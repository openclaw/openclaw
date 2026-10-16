import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { executeSystemAgentOperation, isPersistentSystemAgentOperation } from "./operations.js";
import type { SystemAgentOverview } from "./overview.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";
import { readLastSystemAgentAuditEntry } from "./system-agent.test-helpers.js";

function createOverview(gatewayReachable: boolean): SystemAgentOverview {
  return {
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
    agents: [
      { id: "main", isDefault: true },
      { id: "work", isDefault: false },
    ],
    defaultAgentId: "main",
    tools: {
      codex: { command: "codex", found: false },
      claude: { command: "claude", found: false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: {
      url: "ws://127.0.0.1:18789",
      source: "test",
      reachable: gatewayReachable,
    },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  };
}

describe("system-agent TUI operations", () => {
  it("refuses doctor repairs before any write or audit", async () => {
    await withTempHome(async () => {
      const { runtime, lines } = createSystemAgentTestRuntime();

      const result = await executeSystemAgentOperation({ kind: "doctor-fix" }, runtime, {
        approved: true,
        auditDetails: { rescue: true },
      });
      expect(result).toEqual({ applied: false });
      expect(isPersistentSystemAgentOperation({ kind: "doctor-fix" })).toBe(false);
      expect(lines.join("\n")).toContain("with OpenClaw stopped");
      expect(lines.join("\n")).toContain("openclaw doctor --fix");
      expect(lines.join("\n")).not.toContain("[openclaw] running: doctor.fix");
      expect(readLastSystemAgentAuditEntry()).toBeUndefined();
    });
  });

  it("requires a primary model for a utility-only agent before launching its TUI", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    const runTui = vi.fn();
    const overview = createOverview(true);
    overview.defaultModel = "fixture/primary";
    overview.agents[1]!.utilityModel = "fixture/utility";
    const result = await executeSystemAgentOperation(
      { kind: "open-tui", agentId: "work" },
      runtime,
      {
        deps: { runTui, loadOverview: async () => overview },
      },
    );
    expect(runTui).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      applied: false,
      message: expect.stringContaining("needs a primary model"),
    });
  });

  it("returns from the agent TUI back to OpenClaw", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runTui = vi.fn(async () => ({
      exitReason: "return-to-system-agent" as const,
      systemAgentMessage: "restart gateway",
    }));

    const result = await executeSystemAgentOperation(
      { kind: "open-tui", agentId: "work" },
      runtime,
      { deps: { runTui, loadOverview: async () => createOverview(false) } },
    );

    expect(runTui).toHaveBeenCalledWith({
      local: true,
      session: "agent:work:main",
      deliver: false,
      historyLimit: 200,
    });
    expect(result).toMatchObject({
      applied: false,
      returnToShell: true,
      nextInput: "restart gateway",
    });
    expect(lines.join("\n")).toContain(
      "[openclaw] returned from agent with request: restart gateway",
    );
  });

  it("connects a fresh hatch to the reachable Gateway", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    const runTui = vi.fn(async () => ({ exitReason: "exit" as const }));

    const overview = createOverview(true);
    overview.defaultModel = "fixture/primary";
    overview.agents[0]!.model = "fixture/primary";
    overview.agents[1]!.model = "fixture/primary";
    overview.agents[1]!.utilityModel = "fixture/utility";
    await executeSystemAgentOperation(
      { kind: "open-tui", agentId: "work", agentDraft: "hatch" },
      runtime,
      { deps: { runTui, loadOverview: async () => overview } },
    );

    expect(runTui).toHaveBeenCalledWith({
      local: false,
      session: "agent:work:main",
      deliver: false,
      historyLimit: 200,
      message: "Wake up, my friend!",
    });
  });

  it("re-enters the OpenClaw shell when the agent TUI returns without a request", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runTui = vi.fn(async () => ({
      exitReason: "return-to-system-agent" as const,
    }));

    const result = await executeSystemAgentOperation({ kind: "open-tui" }, runtime, {
      deps: { runTui, loadOverview: async () => createOverview(false) },
    });

    expect(result).toMatchObject({
      applied: false,
      returnToShell: true,
    });
    expect(result.nextInput).toBeUndefined();
    expect(lines.join("\n")).toContain("[openclaw] returned from agent");
  });
});

import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeEach, expect, it, vi } from "vitest";
import { runTui } from "../tui/tui.js";
import type { SystemAgentOperation } from "./operations-parse.js";
import { executeSystemAgentOperation, isPersistentSystemAgentOperation } from "./operations.js";
import { createSystemAgentOverviewFixture } from "./overview.fixture.test-support.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";
import { readLastSystemAgentAuditEntry } from "./system-agent.test-helpers.js";

// mock-isolation: Observe TUI dispatch without opening an interactive terminal or Gateway session.
vi.mock("../tui/tui.js", () => ({ runTui: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

function createOverview(gatewayReachable: boolean) {
  const overview = createSystemAgentOverviewFixture({
    agents: [
      { id: "main", isDefault: true },
      { id: "work", isDefault: false },
    ],
  });
  overview.gateway.reachable = gatewayReachable;
  return overview;
}

async function openTui(
  overview = createOverview(false),
  options: Omit<Extract<SystemAgentOperation, { kind: "open-tui" }>, "kind"> = {},
) {
  const output = createSystemAgentTestRuntime();
  const result = await executeSystemAgentOperation(
    { kind: "open-tui", ...options },
    output.runtime,
    { deps: { loadOverview: async () => overview } },
  );
  return { ...output, result };
}

it("refuses doctor repairs before any write or audit", () =>
  withTempHome(async () => {
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
  }));

it("requires a primary model for a utility-only agent before launching its TUI", async () => {
  const overview = createOverview(true);
  overview.defaultModel = "fixture/primary";
  overview.agents[1]!.utilityModel = "fixture/utility";
  const { result } = await openTui(overview, { agentId: "work" });
  expect(runTui).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    applied: false,
    message: expect.stringContaining("needs a primary model"),
  });
});

it.each(["restart gateway", undefined])(
  "returns from the agent TUI with request %s",
  async (message) => {
    vi.mocked(runTui).mockResolvedValue({
      exitReason: "return-to-system-agent" as const,
      systemAgentMessage: message,
    });

    const agentId = message ? "work" : undefined;
    const { result, lines } = await openTui(createOverview(false), { agentId });

    expect(runTui).toHaveBeenCalledWith({
      local: true,
      session: `agent:${agentId ?? "main"}:main`,
      deliver: false,
      historyLimit: 200,
    });
    expect(result).toMatchObject({ applied: false, returnToShell: true, nextInput: message });
    expect(lines.join("\n")).toContain(
      message
        ? `[openclaw] returned from agent with request: ${message}`
        : "[openclaw] returned from agent",
    );
  },
);

it("connects a fresh hatch to the reachable Gateway", async () => {
  vi.mocked(runTui).mockResolvedValue({ exitReason: "exit" });

  const overview = createOverview(true);
  overview.agents[1]!.model = "fixture/primary";
  overview.agents[1]!.utilityModel = "fixture/utility";
  await openTui(overview, { agentId: "work", agentDraft: "hatch" });

  expect(runTui).toHaveBeenCalledWith({
    local: false,
    session: "agent:work:main",
    deliver: false,
    historyLimit: 200,
    message: "Wake up, my friend!",
  });
});

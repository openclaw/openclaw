import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { supportedSpawnModelChoice } from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

vi.mock("../subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: vi.fn(),
}));
vi.mock("../subagents/spawn/subagent-spawn.runtime.js", () => ({
  prepareModelChoice: supportedSpawnModelChoice,
}));

describe("sessions_spawn with retained completion deliveries", () => {
  beforeEach(() => {
    subagentRuns.clear();
    for (let index = 0; index < 53; index += 1) {
      const entry = createSubagentRunRecord({
        runId: `suspended-${index}`,
        childSessionKey: `agent:main:subagent:suspended-${index}`,
        requesterSessionKey: `agent:main:dashboard:requester-${index}`,
        endedAt: Date.now() - 60_000,
        outcome: { status: "ok" },
        delivery: { status: "suspended", suspendedAt: Date.now(), suspendedReason: "expiry" },
      });
      subagentRuns.set(entry.runId, entry);
    }
  });

  afterEach(() => {
    subagentRuns.clear();
  });

  it("starts visible work without changing suspended results", async () => {
    const backlog = structuredClone([...subagentRuns.values()]);
    await withTestDir({ prefix: "openclaw-spawn-delivery-backlog-" }, async (dir) => {
      const gateway = { call: callInProcessGatewayTool };
      const callGateway = vi.spyOn(gateway, "call").mockResolvedValue({
        key: "agent:main:dashboard:new-child",
        runStarted: true,
        runId: "run-visible",
      });
      const registerRun = vi.fn();
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config: {
          session: { store: path.join(dir, "sessions.json") },
          agents: { entries: { main: { workspace: dir } } },
        },
        callGateway: gateway.call,
        registerRun,
      });

      const result = await tool.execute("start-visible", { task: "investigate", visible: true });

      expect(result.details).toMatchObject({ status: "accepted", runId: "run-visible" });
      expect(callGateway).toHaveBeenCalledExactlyOnceWith(
        "sessions.create",
        expect.objectContaining({ parentSessionKey: "agent:main:main" }),
      );
      expect(registerRun).toHaveBeenCalledOnce();
      expect([...subagentRuns.values()]).toEqual(backlog);
    });
  });
});

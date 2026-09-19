import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerAcpRuntimeBackend,
  testing as acpRuntimeTesting,
} from "../../acp/runtime/registry.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { supportedSpawnModelChoice } from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

const mocks = vi.hoisted(() => ({
  spawnSubagentDirect: vi.fn(),
  spawnAcpDirect: vi.fn(),
}));

vi.mock("../subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: mocks.spawnSubagentDirect,
}));
vi.mock("../subagents/spawn/acp-spawn.js", () => ({
  spawnAcpDirect: mocks.spawnAcpDirect,
}));
vi.mock("../subagents/spawn/subagent-spawn-deps.js", () => ({
  getSubagentSpawnDeps: () => ({ prepareModelChoice: supportedSpawnModelChoice }),
}));

describe("sessions_spawn with retained completion deliveries", () => {
  beforeEach(() => {
    subagentRuns.clear();
    acpRuntimeTesting.resetAcpRuntimeBackendsForTests();
    mocks.spawnSubagentDirect.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:new-child",
      runId: "run-native",
    });
    mocks.spawnAcpDirect.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:acp:new-child",
      runId: "run-acp",
    });
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
    acpRuntimeTesting.resetAcpRuntimeBackendsForTests();
  });

  it.each([
    { label: "native", args: { runtime: "subagent" }, spawn: mocks.spawnSubagentDirect },
    { label: "acp", args: { runtime: "acp" }, spawn: mocks.spawnAcpDirect },
    { label: "visible", args: { visible: true } },
  ])("starts $label work without changing suspended results", async ({ label, args, spawn }) => {
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime: {
        ensureSession: vi.fn(),
        async *runTurn() {},
        cancel: vi.fn(),
        close: vi.fn(),
      },
    });
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

      const result = await tool.execute(`start-${label}`, { task: "investigate", ...args });

      expect(result.details).toMatchObject({ status: "accepted", runId: `run-${label}` });
      if (spawn) {
        expect(spawn).toHaveBeenCalledOnce();
        expect(callGateway).not.toHaveBeenCalled();
      } else {
        expect(callGateway).toHaveBeenCalledExactlyOnceWith(
          "sessions.create",
          expect.objectContaining({ parentSessionKey: "agent:main:main" }),
        );
        expect(registerRun).toHaveBeenCalledOnce();
      }
      expect([...subagentRuns.values()]).toEqual(backlog);
    });
  });
});

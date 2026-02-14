import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const callGatewayMock = vi.fn();
const onAgentEventMock = vi.fn(() => () => {});

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let configOverride: OpenClawConfig = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

vi.mock("../../infra/agent-events.js", () => ({
  onAgentEvent: (...args: unknown[]) => onAgentEventMock(...args),
}));

vi.mock("../subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

vi.mock("../subagent-announce.js", () => ({
  buildSubagentSystemPrompt: vi.fn(() => "subagent-system-prompt"),
  runSubagentAnnounceFlow: vi.fn(async () => true),
}));

import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";
import {
  addSubagentRunForTests,
  getActiveChildCount,
  releaseChildSlot,
  reserveChildSlot,
  resetSubagentRegistryForTests,
} from "../subagent-registry.js";

function baseConfig(): OpenClawConfig {
  return {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    agents: {
      list: [{ id: "main", subagents: { maxChildrenPerAgent: 1 } }],
    },
  };
}

function createTool(agentSessionKey = "main") {
  return createSessionsSpawnTool({
    agentSessionKey,
    agentChannel: "discord",
  });
}

beforeEach(() => {
  configOverride = baseConfig();
  callGatewayMock.mockReset();
  onAgentEventMock.mockReset();
  resetSubagentRegistryForTests({ persist: false });
});

afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  callGatewayMock.mockReset();
  onAgentEventMock.mockReset();
});

describe("sessions_spawn parent limits + target validation", () => {
  it("returns blocked when parent has maxChildrenPerAgent active children", async () => {
    addSubagentRunForTests({
      runId: "active-1",
      childSessionKey: "agent:main:subagent:active-1",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      task: "already running",
      cleanup: "keep",
      createdAt: Date.now(),
    });

    const result = await createTool().execute("call-parent-limit", {
      task: "new task",
    });

    expect(result.details).toMatchObject({
      status: "blocked",
      reason: "parent_limit",
    });
    expect(String((result.details as { error?: unknown }).error)).toContain("1/1");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows spawn when previous children have completed", async () => {
    addSubagentRunForTests({
      runId: "done-1",
      childSessionKey: "agent:main:subagent:done-1",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      task: "finished",
      cleanup: "keep",
      createdAt: Date.now() - 1000,
      endedAt: Date.now(),
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-after-complete" };
      }
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });

    const result = await createTool().execute("call-after-complete", {
      task: "new task",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-after-complete",
    });
  });

  it("returns unknown agent error before recursive-spawn checks", async () => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [{ id: "main", subagents: { allowRecursiveSpawn: false, allowAgents: ["*"] } }],
      },
    };

    const result = await createTool("agent:main:subagent:parent").execute("call-unknown", {
      task: "route this",
      agentId: "ghost",
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    expect(String((result.details as { error?: unknown }).error)).toContain('Unknown agent: "ghost"');
    expect(String((result.details as { error?: unknown }).error)).toContain("Available: main");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("accepts explicit main target when agents.list is empty", async () => {
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {},
    };

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-main-empty-list" };
      }
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });

    const result = await createTool().execute("call-main-empty-list", {
      task: "spawn main",
      agentId: "main",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-main-empty-list",
    });
  });

  it("reserveChildSlot returns false when active + pending >= max", () => {
    const parentKey = "main";
    addSubagentRunForTests({
      runId: "active-for-reserve",
      childSessionKey: "agent:main:subagent:active-for-reserve",
      requesterSessionKey: parentKey,
      requesterDisplayKey: "main",
      task: "active",
      cleanup: "keep",
      createdAt: Date.now(),
    });

    expect(reserveChildSlot(parentKey, 2)).toBe(true);
    expect(reserveChildSlot(parentKey, 2)).toBe(false);

    releaseChildSlot(parentKey);
  });

  it("releases reserved slot when spawn fails", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        throw new Error("spawn failed");
      }
      return {};
    });

    const result = await createTool().execute("call-failure-release", {
      task: "this will fail",
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    expect(String((result.details as { error?: unknown }).error)).toContain("spawn failed");
    expect(getActiveChildCount("main")).toBe(0);
    expect(reserveChildSlot("main", 1)).toBe(true);
    releaseChildSlot("main");
  });
});

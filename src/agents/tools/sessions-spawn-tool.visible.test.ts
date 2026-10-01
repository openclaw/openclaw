import "./sessions-spawn-tool.mocks.test-support.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectRegisteredSubagentRun,
  supportedSpawnModelChoice,
} from "../subagents/spawn/subagent-spawn.test-helpers.js";

const { hoisted } = await import("./sessions-spawn-tool.mocks.test-support.js");
let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;

describe("sessions_spawn visible work receipts", () => {
  beforeAll(async () => {
    ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
  });

  beforeEach(() => {
    hoisted.prepareModelChoiceMock.mockReset().mockImplementation(supportedSpawnModelChoice);
    hoisted.inProcessCreationMock.mockReset();
  });

  it("creates visible sessions while carrying inherited tool restrictions forward", async () => {
    hoisted.inProcessCreationMock.mockResolvedValue({
      key: "agent:main:dashboard:restricted-child",
      runStarted: true,
      runId: "run-visible-restricted",
    });
    const registerRun = vi.fn();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        agents: {
          defaults: { model: "mock-provider/primary" },
          list: [{ id: "main", identity: { name: "Roboclaw" } }],
        },
        gateway: { publicOrigin: "https://openclaw.example", controlUi: { basePath: "/control" } },
      },
      inheritedToolAllowlist: ["read", "sessions_spawn"],
      inheritedToolDenylist: ["exec"],
      registerRun,
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-restricted", {
      task: "inspect",
      label: "Track upstream fix",
      visible: true,
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      childSessionKey: "agent:main:dashboard:restricted-child",
      runId: "run-visible-restricted",
      sessionUrl: "https://openclaw.example/control/chat/main/dashboard/restricted-child",
      label: "Track upstream fix",
      owner: { type: "agent", id: "main", label: "Roboclaw" },
    });
    expect(hoisted.inProcessCreationMock).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        agentId: "main",
        label: "Track upstream fix",
        parentSessionKey: "agent:main:main",
        spawnDepth: 1,
      }),
      {
        via: "spawn",
        actor: { type: "agent", id: "main" },
        requesterSessionKey: "agent:main:main",
        completionOwnerSessionKey: "agent:main:main",
        spawnModelAutoSelection: { model: "mock-provider/primary", hasFallbackOrigin: false },
        inheritedToolPolicy: {
          version: 1,
          allow: ["read", "sessions_spawn"],
          deny: ["exec"],
        },
      },
      undefined,
    );
    expectRegisteredSubagentRun(registerRun, {
      childSessionKey: "agent:main:dashboard:restricted-child",
      runId: "run-visible-restricted",
    });
  });
});

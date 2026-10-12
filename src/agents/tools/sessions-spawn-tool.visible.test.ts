import "./sessions-spawn-tool.mocks.test-support.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindChildSessionPublication,
  admitChildSessionPublication,
  readChildSessionPublication,
} from "../../channels/message-access/child-session-publication.js";
import {
  prepareDelegatedToolDenyFloor,
  resolveConversationCapabilityProfile,
} from "../conversation-capability-profile.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import { countActiveRunsForSessionFromRuns } from "../subagents/registry/subagent-registry-queries.js";
import {
  expectRegisteredSubagentRun,
  supportedSpawnModelChoice,
} from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

const { hoisted } = await import("./sessions-spawn-tool.mocks.test-support.js");
let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;

describe("sessions_spawn visible work receipts", () => {
  beforeAll(async () => {
    ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
  });

  beforeEach(() => {
    hoisted.prepareModelChoiceMock.mockReset().mockImplementation(supportedSpawnModelChoice);
    hoisted.inProcessCreationMock.mockReset();
    hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:other:subagent:helper",
      runId: "native-child",
      context: "isolated",
    });
    hoisted.spawnAcpDirectMock.mockReset();
  });

  it("delegates an explicitly granted coding target without the front-door local tool ceiling", async () => {
    hoisted.inProcessCreationMock.mockResolvedValue({
      key: "agent:worker:dashboard:coding-child",
      runStarted: true,
      runId: "coding-child-run",
    });
    const config = {
      agents: {
        defaults: { model: "mock-provider/primary" },
        entries: {
          main: {
            tools: { deny: ["exec", "write", "edit", "apply_patch"] },
            subagents: { allowAgents: ["worker"], delegateToolsTo: ["worker"] },
          },
          worker: {},
        },
      },
    };
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config,
      senderIsOwner: true,
      delegatedToolDenyFloor: prepareDelegatedToolDenyFloor(
        resolveConversationCapabilityProfile({
          config,
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
      ),
      inheritedToolDenylist: ["exec", "write", "edit", "apply_patch"],
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });
    const result = await tool.execute("authorized-coding-handoff", {
      task: "Implement and test the requested repository fix",
      agentId: "worker",
      visible: true,
    });
    expect(result.details).toMatchObject({ status: "accepted" });
    expect(hoisted.inProcessCreationMock.mock.calls[0]?.[2]).toMatchObject({
      inheritedToolPolicy: {
        version: 1,
        allow: [],
        deny: ["exec", "write", "edit", "apply_patch"],
        delegatedToolPolicy: expect.objectContaining({
          requesterSessionKey: "agent:main:main",
          targetAgentId: "worker",
          deny: [],
        }),
      },
    });
  });

  it.each(["subagent", "acp"])("refuses another agent before dispatching %s", async (runtime) => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      senderIsOwner: true,
      config: {
        agents: {
          entries: {
            main: { subagents: { allowAgents: ["other"], delegateToolsTo: ["other"] } },
            other: {},
          },
        },
      },
      delegatedToolDenyFloor: { policyAgentId: "main", deny: [] },
      inheritedToolPolicySource: "sender",
      inheritedToolAllowlist: ["read", "sessions_spawn"],
    });
    const result = await tool.execute("restricted-cross-agent", {
      task: "inspect",
      runtime,
      agentId: "other",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
      error: "This sender may only start hidden helpers of the same agent.",
    });
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.inProcessCreationMock).not.toHaveBeenCalled();
  });

  it("does not accept a delegated ceiling or grant from model arguments", async () => {
    hoisted.inProcessCreationMock.mockResolvedValue({
      key: "agent:worker:dashboard:ordinary-child",
      runStarted: true,
      runId: "ordinary-child-run",
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        agents: {
          defaults: { model: "mock-provider/primary" },
          entries: { main: { subagents: { allowAgents: ["worker"] } }, worker: {} },
        },
      },
      inheritedToolDenylist: ["exec"],
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });
    const result = await tool.execute("forged-delegation", {
      task: "inspect",
      agentId: "worker",
      visible: true,
      delegateToolsTo: ["worker"],
      delegatedToolDenyFloor: { deny: [] },
      delegatedToolPolicy: { requesterAgentId: "main", targetAgentId: "worker", deny: [] },
    });
    expect(result.details).toMatchObject({ status: "accepted" });
    const creation = hoisted.inProcessCreationMock.mock.calls[0]?.[2];
    expect(creation.inheritedToolPolicy).toMatchObject({ deny: ["exec"] });
    expect(creation.inheritedToolPolicy.delegatedToolPolicy).toBeUndefined();
  });

  it("carries only host invocation intent to creation and reports the exact committed publication", async () => {
    const key = "agent:main:main";
    const context = {};
    const run = { runId: "public-source", instanceId: "public-source-instance" };
    bindChildSessionPublication(context, key, () => {});
    admitChildSessionPublication(context, run, () => {});
    const publication = readChildSessionPublication(run);
    hoisted.inProcessCreationMock.mockResolvedValue({
      key: "agent:main:dashboard:public-child",
      sessionId: "public-child",
      runStarted: true,
      runId: "public-child-run",
      publicRead: true,
      entry: { sessionId: "public-child", updatedAt: 1 },
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: key,
      config: { agents: { defaults: { model: "mock-provider/primary" }, entries: { main: {} } } },
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });
    const result = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: key, operationalRunInstance: run },
      () => tool.execute("public-spawn", { task: "inspect", visible: true }),
    );
    expect(hoisted.inProcessCreationMock.mock.calls[0]?.[2]).toMatchObject({
      childSessionPublication: publication,
    });
    expect(hoisted.inProcessCreationMock.mock.calls[0]?.[1]).not.toHaveProperty(
      "childSessionPublication",
    );
    expect(result.details).toMatchObject({ status: "accepted", publicRead: true });
  });

  it("keeps visible child quotas separate for agents sharing a bare requester key", async () => {
    hoisted.prepareModelChoiceMock.mockResolvedValue({
      kind: "automatic",
      ref: { provider: "mock-provider", model: "primary" },
    });
    const otherAgentRun = createSubagentRunRecord({
      runId: "other-agent-run",
      childSessionKey: "agent:other:subagent:child",
      requesterSessionKey: "global",
      requesterAgentId: "other",
      createdAt: Date.now(),
    });
    const runs = new Map([[otherAgentRun.runId, otherAgentRun]]);
    hoisted.inProcessCreationMock.mockResolvedValue({
      key: "agent:main:dashboard:quota-child",
      runStarted: true,
      runId: "quota-child-run",
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "global",
      requesterAgentIdOverride: "main",
      config: {
        session: { scope: "global" },
        agents: {
          defaults: {
            model: "mock-provider/primary",
            subagents: { maxChildrenPerAgent: 1 },
          },
          entries: { main: {}, other: {} },
        },
      },
      registerRun: vi.fn(),
      countActiveRuns: (key, options) => countActiveRunsForSessionFromRuns(runs, key, options),
    });

    const result = await tool.execute("visible-bare-key-quota", {
      task: "inspect the repository",
      visible: true,
    });

    expect(result.details).toMatchObject({ status: "accepted", runId: "quota-child-run" });
  });

  it.each([undefined, "sender"] as const)(
    "applies visible spawn policy for source %s",
    async (source) => {
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
            entries: { main: { identity: { name: "Roboclaw" } } },
          },
          gateway: {
            publicOrigin: "https://openclaw.example",
            controlUi: { basePath: "/control" },
          },
        },
        inheritedToolPolicySource: source,
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

      if (source === "sender") {
        expect(result.details).toMatchObject({
          status: "forbidden",
          error: "This sender may only start hidden helpers of the same agent.",
        });
        expect(hoisted.inProcessCreationMock).not.toHaveBeenCalled();
        expect(registerRun).not.toHaveBeenCalled();
        return;
      }
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
          requesterSenderIsOwner: false,
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
    },
  );
});

import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { Value } from "typebox/value";
import { afterAll, expect, it, vi, type Mock } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { createAgentsWaitTool } from "./agents-wait-tool.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";
import type { createSessionsSpawnTool as SpawnToolFactory } from "./sessions-spawn-tool.js";

const requireRecord = createRequireRecord("record", "expected-label");
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-spawn-guidance-");

export function registerSessionsSpawnInputTests({
  createTool,
  registerAcpBackendForTest,
  mockGateway,
  mocks: hoisted,
}: {
  createTool: typeof SpawnToolFactory;
  registerAcpBackendForTest: () => void;
  mockGateway: (response: Record<string, unknown>) => InProcessGatewayCaller;
  mocks: {
    spawnSubagentDirectMock: Mock;
    spawnAcpDirectMock: Mock;
    inProcessCreationMock: Mock;
  };
}) {
  it.each([false, true])(
    "keeps collector inputs within the declared spawn contract (placement=%s)",
    (workerPlacement) => {
      const tool = createTool({ workerPlacement });
      finalizeAgentToolAvailability([tool, createAgentsWaitTool({})]);
      expect(Value.Check(tool.parameters, { task: "ordinary child" })).toBe(true);
      expect(Value.Check(tool.parameters, { task: "collector child", collect: true })).toBe(
        !workerPlacement,
      );
    },
  );

  it.each([
    ["private ACP", { completionTarget: "parent", runtime: "acp" }, /completionTarget/],
    ["private visible", { completionTarget: "parent", visible: true }, /completionTarget/],
    ["invalid completion target", { completionTarget: "channel" }, /completionTarget/],
    ["schema without collect", { outputSchema: { type: "object" } }, "requires collect=true"],
    ["group without collect", { groupId: "swarm:custom" }, "requires collect=true"],
    [
      "negative timeout",
      { runTimeoutSeconds: -1 },
      "runTimeoutSeconds must be a non-negative integer",
    ],
    [
      "nonnumeric timeout",
      { runTimeoutSeconds: "not-a-number" },
      "runTimeoutSeconds must be a non-negative integer",
    ],
    [
      "retired timeout alias",
      { timeout_seconds: 2 },
      'sessions_spawn does not support "timeout_seconds". Use "runTimeoutSeconds" for a per-run timeout.',
    ],
    [
      "channel delivery",
      { channel: "example" },
      'sessions_spawn does not support "channel"; remove channel-delivery parameters.',
    ],
    [
      "ACP light context",
      { runtime: "acp", lightContext: true },
      "lightContext is only supported for runtime='subagent'.",
    ],
    [
      "ACP managed worktree",
      { runtime: "acp", projectId: "example", worktree: true },
      'Managed worktree parameters are unavailable with runtime="acp"',
    ],
    [
      "hidden project without worktree",
      { projectId: "example" },
      "Hidden native subagents require worktree=true",
    ],
    [
      "hidden worktree name without worktree",
      { worktreeName: "review" },
      "Hidden native subagents require worktree=true",
    ],
    [
      "hidden worktree base without worktree",
      { worktreeBaseRef: "origin/main" },
      "Hidden native subagents require worktree=true",
    ],
    [
      "hidden cloud placement",
      { placement: { kind: "profile", profileId: "build" } },
      "Cloud placement requires visible=true and worktree=true. Corrected call: sessions_spawn(",
    ],
  ] as const)("%s is rejected before dispatch", async (_name, input, error) => {
    registerAcpBackendForTest();
    const tool = createTool({ config: { tools: { swarm: true } } });
    await expect(tool.execute("invalid", { task: "inspect", ...input })).rejects.toThrow(error);
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.inProcessCreationMock).not.toHaveBeenCalled();
  });

  it("gives an executable visible retry for visible-only parameters on a hidden spawn", async () => {
    const callGateway = mockGateway({
      key: "agent:main:dashboard:child",
      runStarted: true,
      runId: "run-visible",
    });
    const tool = createTool({
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
      config: { agents: { entries: { main: {} } }, tools: { swarm: true } },
      callGateway,
    });
    finalizeAgentToolAvailability([tool, createAgentsWaitTool({})]);
    const error = await tool
      .execute("hidden-visible-options", {
        task: "Review the API change",
        group: "Reviews",
        projectGitUrl: "https://github.com/example/project.git",
        worktreeName: "api-review",
        worktreeBaseRef: "origin/main",
        completionTarget: "parent",
        cleanup: "delete",
        mode: "run",
        thread: false,
        thinking: "high",
        lightContext: true,
        attachments: [{ name: "notes.txt", content: "review notes" }],
        attachAs: { mountPath: "/inputs" },
        collect: true,
        outputSchema: { type: "object" },
        fastMode: "auto",
        groupId: "review-batch",
        streamTo: "parent",
        resumeSessionId: "prior-acp-session",
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("Expected visible-only parameter rejection");
    }
    expect(error.message).toContain("Parameters require visible=true: group, projectGitUrl");
    expect(callGateway).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    const match = /Corrected visible call: sessions_spawn\((.*)\)$/.exec(error.message);
    if (!match?.[1]) {
      throw new Error("Expected an exact corrected sessions_spawn call");
    }
    const corrected: unknown = JSON.parse(match[1]);
    expect(corrected).toEqual({
      task: "Review the API change",
      group: "Reviews",
      projectGitUrl: "https://github.com/example/project.git",
      worktreeName: "api-review",
      worktreeBaseRef: "origin/main",
      worktree: true,
      runtime: "subagent",
      visible: true,
    });

    const result = await tool.execute("corrected-visible", corrected);

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-visible" });
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("registers requester target guidance in the description, not the agentId schema", () => {
    registerAcpBackendForTest();
    const config = {
      acp: { defaultAgent: "codex" },
      tools: { swarm: { defaultAgentId: "planner" } },
      agents: {
        defaults: { subagents: { allowAgents: ["main", "planner"] } },
        entries: { main: {}, planner: {} },
      },
    };
    const tool = createTool({ config });
    expect(tool.description).toContain(
      'With runtime="subagent" (default): Configured agent to target: main, planner.',
    );
    expect(tool.description).toContain(
      'With collect=true, omit to target tools.swarm.defaultAgentId ("planner")',
    );
    expect(tool.description).toContain('With runtime="acp": ACP harness id');
    // Codex strips schema descriptions on large tool schemas; guidance must not ride on them.
    const schema = requireRecord(tool.parameters, "schema");
    expect(requireRecord(schema.properties, "properties").agentId).not.toHaveProperty(
      "description",
    );
    const swarmOff = createTool({
      config: { ...config, tools: { swarm: { enabled: false, defaultAgentId: "planner" } } },
    });
    expect(swarmOff.description).not.toContain("collect=true");
  });

  it("narrows ACP guidance from the prepared requester fact, never a store read", async () => {
    registerAcpBackendForTest();
    const dir = sessionDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const config = {
      session: { store: storePath },
      acp: { defaultAgent: "codex" },
      agents: {
        entries: { main: { subagents: { allowAgents: ["codex"], requireAgentId: true } } },
      },
    };
    const narrowed = 'With runtime="acp": ACP harness id from: codex. agentId is required.';
    const omitDefault = 'Omit to use the configured ACP default ("codex")';
    const descriptionFor = (agentSessionKey: string, requesterIsSubagent?: boolean) =>
      createTool({ agentSessionKey, config, requesterIsSubagent }).description;
    // A stored subagent envelope on a non-subagent key must not narrow guidance.
    const storedKey = "agent:main:acp:child";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: storedKey, storePath },
      { sessionId: storedKey, updatedAt: 1, spawnedBy: "agent:main:subagent:parent" },
    );
    expect(descriptionFor(storedKey)).toContain(omitDefault);
    expect(descriptionFor(storedKey, true)).toContain(narrowed);
    expect(descriptionFor("agent:main:subagent:child")).toContain(narrowed);
    expect(descriptionFor("agent:main:main")).toContain(omitDefault);
  });

  it("advertises only the requester to a sender-restricted session", () => {
    registerAcpBackendForTest();
    const config = {
      acp: { defaultAgent: "codex" },
      tools: { swarm: { defaultAgentId: "planner" } },
      agents: {
        defaults: { subagents: { allowAgents: ["main", "planner"] } },
        entries: { main: {}, planner: {} },
      },
    };
    const description = createTool({ config, inheritedToolPolicySource: "sender" }).description;
    expect(description).toContain(
      "Sender policy allows only hidden helpers of the requester agent",
    );
    expect(description).toContain('With runtime="acp": No ACP harness id is allowed.');
    expect(description).not.toContain("Configured agent to target");
    expect(description).toContain(
      'tools.swarm.defaultAgentId ("planner") is not an allowed target',
    );
  });

  it("applies requester target policy to sender-restricted top-level ACP guidance", () => {
    registerAcpBackendForTest();
    const config = {
      acp: { defaultAgent: "main", allowedAgents: ["main"] },
      agents: { entries: { main: { subagents: { requireAgentId: true } } } },
    };
    const description = createTool({
      config,
      workspaceDir: "/work",
      inheritedToolPolicySource: "sender",
    }).description;
    expect(description).toContain(
      'With runtime="acp": ACP harness id from: main. agentId is required.',
    );
  });
}

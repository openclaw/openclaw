import { Value } from "typebox/value";
import { expect, it, vi, type Mock } from "vitest";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { createAgentsWaitTool } from "./agents-wait-tool.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";
import type { createSessionsSpawnTool as SpawnToolFactory } from "./sessions-spawn-tool.js";

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
      config: { agents: { list: [{ id: "main" }] }, tools: { swarm: true } },
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
}

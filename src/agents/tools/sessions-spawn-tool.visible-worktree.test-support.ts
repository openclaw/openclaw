import path from "node:path";
import { expect, it, vi } from "vitest";
import type { ExecutionDecisionWork } from "../../audit/execution-decision-work.types.js";
import { expectRegisteredSubagentRun } from "../subagents/spawn/subagent-spawn.test-helpers.js";
import type { callInProcessGatewayTool } from "./in-process-gateway.js";
import type { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

const { hoisted } = await import("./sessions-spawn-tool.mocks.test-support.js");

type SpawnOptions = NonNullable<Parameters<typeof createSessionsSpawnTool>[0]>;

/**
 * Visible worktree-fork creation shares the parent suite's spawn helpers. Kept
 * beside that suite so the parent file stays under its line cap.
 */
export function registerSessionsSpawnVisibleWorktreeTests({
  makeVisibleTool,
  mockGateway,
  visibleCreated,
  makeSessionDir,
  captureSessionDecisionWork,
}: {
  makeVisibleTool: (options?: SpawnOptions) => ReturnType<typeof createSessionsSpawnTool>;
  mockGateway: (response?: Record<string, unknown>) => typeof callInProcessGatewayTool;
  visibleCreated: { key: string; runStarted: boolean; runId: string };
  makeSessionDir: () => string;
  captureSessionDecisionWork: <T>(
    run: () => Promise<T>,
  ) => Promise<{ result: T; work: ExecutionDecisionWork[] }>;
}) {
  it("creates a visible worktree fork and registers its current completion destination", async () => {
    const dir = makeSessionDir();
    const callGateway = mockGateway(visibleCreated);
    const registerRun = vi.fn();
    const tool = makeVisibleTool({
      requesterTurnRunId: "run-requester-visible-worktree",
      agentChannel: "slack",
      agentTo: "channel:C-stale",
      agentThreadId: "stale-thread",
      currentMessagingTarget: "channel:C-current",
      currentChannelId: "C-native",
      currentThreadTs: "current-thread",
      config: {
        session: { store: path.join(dir, "sessions.json") },
        agents: { defaults: { subagents: { model: "openai/gpt-5.4", runTimeoutSeconds: 120 } } },
      },
      callGateway,
      registerRun,
    });
    const worktree = {
      cwd: dir,
      worktree: true,
      worktreeName: "issue-review",
      worktreeBaseRef: "main",
    };
    const { result, work } = await captureSessionDecisionWork(() =>
      tool.execute("visible", {
        ...worktree,
        task: "inspect issue",
        label: "Issue review",
        group: "Beta feedback",
        model: "anthropic/claude-sonnet-4-6",
        context: "fork",
        visible: true,
        cleanup: "delete",
      }),
    );
    expect(result.details).toMatchObject({
      status: "accepted",
      childSessionKey: visibleCreated.key,
      runId: "run-visible",
      cleanup: "keep",
    });
    expect(callGateway).toHaveBeenCalledWith("sessions.create", {
      ...worktree,
      agentId: "main",
      label: "Issue review",
      category: "Beta feedback",
      model: "anthropic/claude-sonnet-4-6",
      thinkingLevel: "medium",
      task: expect.stringContaining("inspect issue"),
      timeoutMs: 120000,
      parentSessionKey: "agent:main:main",
      spawnDepth: 1,
      fork: true,
    });
    expectRegisteredSubagentRun(registerRun, {
      runId: "run-visible",
      requesterTurnRunId: "run-requester-visible-worktree",
      childSessionKey: visibleCreated.key,
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "slack", to: "channel:C-current", threadId: "current-thread" },
      cleanup: "keep",
      runTimeoutSeconds: 120,
      expectsCompletionMessage: true,
      spawnMode: "run",
    });
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      receipt: {
        action: { family: "session", operation: "fork" },
        decision: { outcome: "allowed", reasonCode: "session_fork_committed" },
        enforcement: { coverageState: "attribution-only" },
      },
      refs: { target: { namespace: "session", value: '["main","agent:main:dashboard:child"]' } },
    });
  });
}

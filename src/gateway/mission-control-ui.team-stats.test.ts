import { describe, expect, it } from "vitest";
import { computeAgentStats } from "../../mission-control-ui/src/lib/team-stats";
import type { AgentRun, OperatorTaskRecord } from "../../mission-control-ui/src/types";

function createTask(
  params: {
    taskId?: string;
    state?: OperatorTaskRecord["receipt"]["state"];
    owner?: string;
    failureCode?: string | null;
    createdAt?: number;
    updatedAt?: number;
    outcome?: OperatorTaskRecord["outcome"];
  } = {},
): OperatorTaskRecord {
  const taskId = params.taskId ?? "task-1";
  return {
    envelope: {
      task_id: taskId,
      requester: {
        id: "tonya",
        kind: "operator",
      },
      target: {
        capability: "marketing",
        team_id: "marketing",
        alias: "angela",
      },
      objective: "Ship campaign draft",
      tier: "STANDARD",
      acceptance_criteria: ["draft delivered"],
      timeout_s: 900,
    },
    receipt: {
      task_id: taskId,
      run_id: `run-${taskId}`,
      state: params.state ?? "completed",
      owner: params.owner ?? "angela",
      attempt: 0,
      created_at: params.createdAt ?? 1_700_000_000_000,
      updated_at: params.updatedAt ?? 1_700_000_060_000,
      artifacts: [],
      failure_code: params.failureCode ?? null,
    },
    events: [],
    validation: null,
    outcome: params.outcome ?? null,
  };
}

describe("mission control team stats", () => {
  it("counts receipt-only completions as success for external specialists", () => {
    const stats = computeAgentStats(
      "angela",
      [
        createTask({ taskId: "task-success", state: "completed" }),
        createTask({ taskId: "task-failure", state: "dead-letter", failureCode: "tool-timeout" }),
      ],
      [],
    );

    expect(stats.tasksTotal).toBe(2);
    expect(stats.tasksCompleted).toBe(1);
    expect(stats.tasksFailed).toBe(1);
    expect(stats.successRate).toBe(0.5);
    expect(stats.failureRate).toBe(0.5);
  });

  it("keeps average completion time in milliseconds", () => {
    const stats = computeAgentStats(
      "angela",
      [
        createTask({
          taskId: "task-a",
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_030_000,
        }),
        createTask({
          taskId: "task-b",
          createdAt: 1_700_000_100_000,
          updatedAt: 1_700_000_160_000,
        }),
      ],
      [] as AgentRun[],
    );

    expect(stats.avgTimeToCompleteMs).toBe(45_000);
  });
});

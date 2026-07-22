import type { ExecutionCompletedEvent, ReviewCompletedEvent } from "@openclaw/contracts";
import { describe, expect, it, vi } from "vitest";
import { PlatformJobOrchestrator, type RunPlatformJobParams } from "./platform-job-orchestrator.js";
import type {
  PlatformIdentityPort,
  PlatformJobFlowState,
  PlatformJobStatePort,
  StoredPlatformJob,
} from "./platform-job-ports.js";

const ids = {
  project: "prj_018f0000-0000-7000-8000-000000000001",
  git: "git_018f0000-0000-7000-8000-000000000002",
  skill: "skl_018f0000-0000-7000-8000-000000000003",
  job: "job_018f0000-0000-7000-8000-000000000004",
  message: "msg_018f0000-0000-7000-8000-000000000005",
  execution: "exe_018f0000-0000-7000-8000-000000000006",
  worktree: "wtr_018f0000-0000-7000-8000-000000000007",
  artifact: "art_018f0000-0000-7000-8000-000000000008",
  evidence: "evd_018f0000-0000-7000-8000-000000000009",
  review: "rev_018f0000-0000-7000-8000-00000000000a",
  promotion: "pro_018f0000-0000-7000-8000-00000000000b",
} as const;

const baseCommit = "1".repeat(40);
const executionCommit = "2".repeat(40);
const promotionCommit = "3".repeat(40);
const timestamp = "2026-07-18T12:00:00.000Z";

class MemoryStatePort implements PlatformJobStatePort {
  records: PlatformJobFlowState[] = [];

  create(state: PlatformJobFlowState): StoredPlatformJob {
    this.records.push(structuredClone(state));
    return { flowId: "flow-1", revision: 0, state };
  }

  get(flowId = "flow-1"): StoredPlatformJob | undefined {
    const state = this.records.at(-1);
    return state ? { flowId, revision: this.records.length - 1, state } : undefined;
  }

  save(flowId: string, expectedRevision: number, state: PlatformJobFlowState): StoredPlatformJob {
    expect(expectedRevision).toBe(this.records.length - 1);
    this.records.push(structuredClone(state));
    return { flowId, revision: expectedRevision + 1, state };
  }
}

class FixedIdentity implements PlatformIdentityPort {
  createId(kind: "job" | "message" | "promotion"): string {
    return ids[kind];
  }
}

function createParams(): RunPlatformJobParams {
  return {
    project: {
      schema_version: "1.0.0",
      project_id: ids.project,
      aggregate_version: 2,
      owner_principal_id: "prn_018f0000-0000-7000-8000-00000000000c",
      display_name: "Platform fixture",
      slug: "platform-fixture",
      project_kind: "application",
      source: { type: "git_repository", git_repository_id: ids.git },
      deployment_policy: { type: "disabled" },
      policy_ids: [],
      tags: [],
      created_at: timestamp,
      updated_at: timestamp,
      git_repository_id: ids.git,
      head_commit_sha: baseCommit,
      git_object_format: "sha1",
      default_branch: "main",
      status: "active",
      repositoryPath: "private/repository/path",
    },
    request: {
      schema_version: "1.0.0",
      project_id: ids.project,
      task: "Implement the approved change",
      priority: "normal",
    },
    skillIds: [ids.skill],
  };
}

function executionCompleted(): ExecutionCompletedEvent {
  return {
    schema_version: "1.0.0",
    message_id: ids.message,
    correlation_id: ids.message,
    causation_id: ids.message,
    occurred_at: timestamp,
    project_id: ids.project,
    job_id: ids.job,
    execution_id: ids.execution,
    worktree_id: ids.worktree,
    commit_sha: executionCommit,
    branch_name: "pi/job",
    artifact_ids: [ids.artifact],
    evidence_ids: [ids.evidence],
    summary: "Execution passed",
  };
}

function reviewCompleted(): ReviewCompletedEvent {
  return {
    schema_version: "1.0.0",
    message_id: ids.message,
    correlation_id: ids.message,
    causation_id: ids.message,
    occurred_at: timestamp,
    project_id: ids.project,
    job_id: ids.job,
    execution_id: ids.execution,
    review_id: ids.review,
    decision: "approved",
    findings: [],
    artifact_ids: [ids.artifact],
    summary: "Approved",
  };
}

function acceptedExecution() {
  return {
    schema_version: "1.0.0" as const,
    message_id: ids.message,
    correlation_id: ids.message,
    project_id: ids.project,
    job_id: ids.job,
    execution_id: ids.execution,
    status: "queued" as const,
    accepted_at: timestamp,
  };
}

function acceptedReview() {
  return {
    schema_version: "1.0.0" as const,
    message_id: ids.message,
    correlation_id: ids.message,
    project_id: ids.project,
    job_id: ids.job,
    execution_id: ids.execution,
    review_id: ids.review,
    status: "queued" as const,
    accepted_at: timestamp,
  };
}

describe("PlatformJobOrchestrator", () => {
  it("runs one approved execution, review, and squash promotion flow", async () => {
    const state = new MemoryStatePort();
    const executionOutcome: ExecutionCompletedEvent = {
      schema_version: "1.0.0",
      message_id: ids.message,
      correlation_id: ids.message,
      causation_id: ids.message,
      occurred_at: timestamp,
      project_id: ids.project,
      job_id: ids.job,
      execution_id: ids.execution,
      worktree_id: ids.worktree,
      commit_sha: executionCommit,
      branch_name: "pi/job",
      artifact_ids: [ids.artifact],
      evidence_ids: [ids.evidence],
      summary: "Execution passed",
    };
    const reviewOutcome: ReviewCompletedEvent = {
      schema_version: "1.0.0",
      message_id: ids.message,
      correlation_id: ids.message,
      causation_id: ids.message,
      occurred_at: timestamp,
      project_id: ids.project,
      job_id: ids.job,
      execution_id: ids.execution,
      review_id: ids.review,
      decision: "approved",
      findings: [],
      artifact_ids: [ids.artifact],
      summary: "Approved",
    };
    const executions = {
      start: vi.fn(async () => ({
        schema_version: "1.0.0" as const,
        message_id: ids.message,
        correlation_id: ids.message,
        project_id: ids.project,
        job_id: ids.job,
        execution_id: ids.execution,
        status: "queued" as const,
        accepted_at: timestamp,
      })),
      wait: vi.fn(async () => executionOutcome),
    };
    const reviews = {
      start: vi.fn(async () => ({
        schema_version: "1.0.0" as const,
        message_id: ids.message,
        correlation_id: ids.message,
        project_id: ids.project,
        job_id: ids.job,
        execution_id: ids.execution,
        review_id: ids.review,
        status: "queued" as const,
        accepted_at: timestamp,
      })),
      wait: vi.fn(async () => reviewOutcome),
    };
    const promotions = {
      promote: vi.fn(async () => ({
        promotionId: ids.promotion,
        commitSha: promotionCommit,
        strategy: "squash" as const,
        pushed: false as const,
      })),
    };
    const orchestrator = new PlatformJobOrchestrator({
      executions,
      reviews,
      promotions,
      state,
      identity: new FixedIdentity(),
      now: () => new Date(timestamp),
    });

    const result = await orchestrator.run(createParams());

    expect(result.state.job.status).toBe("completed");
    expect(result.state.job.aggregate_version).toBe(9);
    expect(state.records.map((record) => record.job.status)).toEqual([
      "queued",
      "executing",
      "executing",
      "awaiting_review",
      "reviewing",
      "reviewing",
      "approved",
      "promoting",
      "completed",
    ]);
    expect(executions.start).toHaveBeenCalledWith(
      expect.objectContaining({
        base_commit_sha: baseCommit,
        skill_ids: [ids.skill],
      }),
      `${ids.job}:execution:1`,
    );
    expect(reviews.start).toHaveBeenCalledWith(
      expect.objectContaining({
        commit_sha: executionCommit,
        worktree_id: ids.worktree,
        artifact_ids: [ids.artifact],
        evidence_ids: [ids.evidence],
      }),
      `${ids.job}:review:1`,
    );
    expect(promotions.promote).toHaveBeenCalledWith(
      expect.objectContaining({
        promotionId: ids.promotion,
        expectedTargetCommitSha: baseCommit,
        sourceCommitSha: executionCommit,
      }),
    );
    expect(JSON.stringify(result.state)).not.toContain("private/repository/path");
    expect(result.state.promotion).toEqual({
      promotionId: ids.promotion,
      commitSha: promotionCommit,
      strategy: "squash",
      pushed: false,
    });
  });

  it("stops before promotion when review requests changes", async () => {
    const state = new MemoryStatePort();
    const params = createParams();
    const orchestrator = new PlatformJobOrchestrator({
      executions: {
        start: async () => ({
          schema_version: "1.0.0",
          message_id: ids.message,
          correlation_id: ids.message,
          project_id: ids.project,
          job_id: ids.job,
          execution_id: ids.execution,
          status: "queued",
          accepted_at: timestamp,
        }),
        wait: async () => ({
          schema_version: "1.0.0",
          message_id: ids.message,
          correlation_id: ids.message,
          causation_id: ids.message,
          occurred_at: timestamp,
          project_id: ids.project,
          job_id: ids.job,
          execution_id: ids.execution,
          worktree_id: ids.worktree,
          commit_sha: executionCommit,
          branch_name: "pi/job",
          artifact_ids: [],
          evidence_ids: [],
          summary: "Execution passed",
        }),
      },
      reviews: {
        start: async () => ({
          schema_version: "1.0.0",
          message_id: ids.message,
          correlation_id: ids.message,
          project_id: ids.project,
          job_id: ids.job,
          execution_id: ids.execution,
          review_id: ids.review,
          status: "queued",
          accepted_at: timestamp,
        }),
        wait: async () => ({
          schema_version: "1.0.0",
          message_id: ids.message,
          correlation_id: ids.message,
          causation_id: ids.message,
          occurred_at: timestamp,
          project_id: ids.project,
          job_id: ids.job,
          execution_id: ids.execution,
          review_id: ids.review,
          decision: "needs_changes",
          findings: [],
          artifact_ids: [],
          summary: "Changes requested",
        }),
      },
      promotions: { promote: vi.fn() },
      state,
      identity: new FixedIdentity(),
      now: () => new Date(timestamp),
    });

    const result = await orchestrator.run(params);

    expect(result.state.job.status).toBe("changes_requested");
    expect(result.state.review?.decision).toBe("needs_changes");
  });

  it.each([
    [
      "execution accepted",
      "platform_execution_accepted_identity_mismatch",
      { executionAcceptedProject: "prj_018f0000-0000-7000-8000-0000000000ff" },
    ],
    [
      "execution terminal",
      "platform_execution_terminal_identity_mismatch",
      { executionTerminalId: "exe_018f0000-0000-7000-8000-0000000000ff" },
    ],
    [
      "review accepted",
      "platform_review_accepted_identity_mismatch",
      { reviewAcceptedExecution: "exe_018f0000-0000-7000-8000-0000000000ff" },
    ],
    [
      "review terminal artifact",
      "platform_review_terminal_identity_mismatch",
      { orphanFindingArtifact: true },
    ],
    [
      "promotion result",
      "platform_promotion_identity_mismatch",
      { promotionId: "pro_018f0000-0000-7000-8000-0000000000ff" },
    ],
  ] as const)("rejects a mismatched %s before persisting it", async (_name, code, mismatch) => {
    const state = new MemoryStatePort();
    const executionOutcome = executionCompleted();
    const reviewOutcome = reviewCompleted();
    const orchestrator = new PlatformJobOrchestrator({
      executions: {
        start: async () => ({
          ...acceptedExecution(),
          project_id:
            "executionAcceptedProject" in mismatch
              ? mismatch.executionAcceptedProject
              : ids.project,
        }),
        wait: async () => ({
          ...executionOutcome,
          execution_id:
            "executionTerminalId" in mismatch ? mismatch.executionTerminalId : ids.execution,
        }),
      },
      reviews: {
        start: async () => ({
          ...acceptedReview(),
          execution_id:
            "reviewAcceptedExecution" in mismatch
              ? mismatch.reviewAcceptedExecution
              : ids.execution,
        }),
        wait: async () => ({
          ...reviewOutcome,
          ...("orphanFindingArtifact" in mismatch
            ? {
                artifact_ids: [],
                findings: [
                  {
                    severity: "error" as const,
                    code: "orphan_artifact",
                    message: "Finding references an unassociated artifact.",
                    artifact_id: ids.artifact,
                  },
                ],
              }
            : {}),
        }),
      },
      promotions: {
        promote: async () => ({
          promotionId: "promotionId" in mismatch ? mismatch.promotionId : ids.promotion,
          commitSha: promotionCommit,
          strategy: "squash",
          pushed: false,
        }),
      },
      state,
      identity: new FixedIdentity(),
      now: () => new Date(timestamp),
    });

    await expect(orchestrator.run(createParams())).rejects.toMatchObject({ code, message: code });
    expect(JSON.stringify(state.records.at(-1))).not.toContain("0000000000ff");
  });

  it("reattaches accepted attempts and replays promotion after restart", async () => {
    class CrashStatePort extends MemoryStatePort {
      crashStatus?: PlatformJobFlowState["job"]["status"];

      override save(
        flowId: string,
        expectedRevision: number,
        state: PlatformJobFlowState,
      ): StoredPlatformJob {
        if (state.job.status === this.crashStatus) {
          this.crashStatus = undefined;
          throw new Error("simulated crash");
        }
        return super.save(flowId, expectedRevision, state);
      }
    }

    const state = new CrashStatePort();
    let executionWaits = 0;
    let reviewWaits = 0;
    const executions = {
      start: vi.fn(async () => acceptedExecution()),
      wait: vi.fn(async () => {
        executionWaits += 1;
        if (executionWaits === 1) {
          throw new Error("connection lost");
        }
        return executionCompleted();
      }),
    };
    const reviews = {
      start: vi.fn(async () => acceptedReview()),
      wait: vi.fn(async () => {
        reviewWaits += 1;
        if (reviewWaits === 1) {
          throw new Error("connection lost");
        }
        return reviewCompleted();
      }),
    };
    const promotions = {
      promote: vi.fn(async () => ({
        promotionId: ids.promotion,
        commitSha: promotionCommit,
        strategy: "squash" as const,
        pushed: false as const,
      })),
    };
    const orchestrator = new PlatformJobOrchestrator({
      executions,
      reviews,
      promotions,
      state,
      identity: new FixedIdentity(),
      now: () => new Date(timestamp),
    });

    await expect(orchestrator.run(createParams())).rejects.toMatchObject({
      code: "platform_operation_failed",
    });
    expect(state.get()?.state.job.status).toBe("executing");
    await expect(
      orchestrator.resume({ flowId: "flow-1", project: createParams().project }),
    ).rejects.toMatchObject({ code: "platform_operation_failed" });
    expect(state.get()?.state.job.status).toBe("reviewing");

    state.crashStatus = "completed";
    await expect(
      orchestrator.resume({ flowId: "flow-1", project: createParams().project }),
    ).rejects.toMatchObject({ code: "platform_state_conflict" });
    expect(state.get()?.state.job.status).toBe("promoting");
    const result = await orchestrator.resume({
      flowId: "flow-1",
      project: createParams().project,
    });

    expect(result.state.job.status).toBe("completed");
    expect(executions.start).toHaveBeenCalledTimes(1);
    expect(reviews.start).toHaveBeenCalledTimes(1);
    expect(promotions.promote).toHaveBeenCalledTimes(2);
    expect(promotions.promote.mock.calls[1]).toEqual(promotions.promote.mock.calls[0]);
    expect(state.records.filter((record) => record.job.status === "queued")).toHaveLength(1);
  });

  it.each(["reviewing", "promoting"] as const)(
    "resumes from the state before %s intent without running the side effect early",
    async (crashStatus) => {
      class IntentCrashStatePort extends MemoryStatePort {
        crashed = false;

        override save(
          flowId: string,
          expectedRevision: number,
          state: PlatformJobFlowState,
        ): StoredPlatformJob {
          if (!this.crashed && state.job.status === crashStatus) {
            this.crashed = true;
            throw new Error("simulated crash");
          }
          return super.save(flowId, expectedRevision, state);
        }
      }

      const state = new IntentCrashStatePort();
      const reviews = {
        start: vi.fn(async () => acceptedReview()),
        wait: vi.fn(async () => reviewCompleted()),
      };
      const promotions = {
        promote: vi.fn(async () => ({
          promotionId: ids.promotion,
          commitSha: promotionCommit,
          strategy: "squash" as const,
          pushed: false as const,
        })),
      };
      const orchestrator = new PlatformJobOrchestrator({
        executions: {
          start: async () => acceptedExecution(),
          wait: async () => executionCompleted(),
        },
        reviews,
        promotions,
        state,
        identity: new FixedIdentity(),
        now: () => new Date(timestamp),
      });

      await expect(orchestrator.run(createParams())).rejects.toMatchObject({
        code: "platform_state_conflict",
      });
      expect(state.get()?.state.job.status).toBe(
        crashStatus === "reviewing" ? "awaiting_review" : "approved",
      );
      expect(
        crashStatus === "reviewing" ? reviews.start : promotions.promote,
      ).not.toHaveBeenCalled();

      const result = await orchestrator.resume({
        flowId: "flow-1",
        project: createParams().project,
      });
      expect(result.state.job.status).toBe("completed");
    },
  );
});

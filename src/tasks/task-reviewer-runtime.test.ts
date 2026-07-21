// Verifies the production reviewer adapter launches and inspects durable subagent runs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "./task-registry.types.js";
import type { TaskReviewDetail } from "./task-review-lifecycle.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  getSubagentRunByRunId: vi.fn(),
  killSubagentRunAdmin: vi.fn(),
  spawnSubagentDirect: vi.fn(),
}));

vi.mock("../agents/subagent-registry.js", () => ({
  getSubagentRunByRunId: mocks.getSubagentRunByRunId,
}));
vi.mock("../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: mocks.spawnSubagentDirect,
}));
vi.mock("../agents/subagent-control.js", () => ({
  killSubagentRunAdmin: mocks.killSubagentRunAdmin,
}));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

const { taskReviewerRuntime } = await import("./task-reviewer-runtime.js");

const task = {
  taskId: "review-task",
  runtime: "subagent",
  requesterSessionKey: "agent:main:main",
  ownerKey: "agent:main:main",
  scopeKind: "session",
  task: "Review exact proof",
  runId: "task-review:dispatch",
  status: "queued",
  notifyPolicy: "state_changes",
  deliveryStatus: "pending",
  createdAt: 1,
} satisfies TaskRecord;

const detail = {
  kind: "managed-review",
  version: 1,
  state: "review_pending",
  dispatchKey: "dispatch",
  reviewerAgentId: "reviewer",
  proofBundle: {
    commit: "1".repeat(40),
    baseCommit: "2".repeat(40),
    diff: { sha256: "3".repeat(64), summary: "fixture", files: [] },
    tests: [],
    screenshots: [],
    criteria: [{ id: "criterion-1", description: "durable" }],
  },
  continuity: {
    ownerKey: "agent:main:main",
    sessionKey: "agent:main:main",
    sessionId: "successor-session",
    compactionCount: 4,
  },
  staleAfterMs: 60_000,
  stateChangedAt: 1,
  recoveryAttempt: 1,
  maxRecoveryAttempts: 2,
  launch: { phase: "claimed", attempt: 1, claimedAt: 1 },
  history: [],
} satisfies TaskReviewDetail;

describe("task reviewer runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the canonical task binding, continuity, and stable replay key to the real launcher seam", async () => {
    mocks.spawnSubagentDirect.mockResolvedValue({
      status: "accepted",
      runId: "reviewer-run",
      childSessionKey: "agent:reviewer:subagent:child",
    });

    await expect(taskReviewerRuntime.launch({ task, detail, recoveryAttempt: 1 })).resolves.toEqual(
      {
        ok: true,
        reviewerRunId: "reviewer-run",
        childSessionKey: "agent:reviewer:subagent:child",
      },
    );
    await expect(taskReviewerRuntime.launch({ task, detail, recoveryAttempt: 1 })).resolves.toEqual(
      {
        ok: true,
        reviewerRunId: "reviewer-run",
        childSessionKey: "agent:reviewer:subagent:child",
      },
    );
    expect(mocks.spawnSubagentDirect).toHaveBeenCalledTimes(2);
    expect(mocks.spawnSubagentDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "reviewer",
        taskRunId: "task-review:dispatch",
        externalTaskLifecycle: true,
        externalLaunchReplayKey: "dispatch:1",
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:main",
        completionOwnerKey: "agent:main:main",
        requesterRunId: "dispatch:1",
      }),
    );
  });

  it("converts a persisted successful completion into a typed decision payload", async () => {
    const decision = {
      outcome: "merge_ready",
      reviewedCommit: "1".repeat(40),
      criteria: [{ id: "criterion-1", status: "passed", evidence: "verified" }],
      findings: [],
    };
    mocks.getSubagentRunByRunId.mockReturnValue({
      childSessionKey: "agent:reviewer:subagent:child",
      endedAt: 2,
      outcome: { status: "ok" },
      completion: { resultText: JSON.stringify(decision) },
    });
    await expect(
      taskReviewerRuntime.inspect({
        reviewerRunId: "reviewer-run",
        childSessionKey: "agent:reviewer:subagent:child",
      }),
    ).resolves.toEqual({ state: "completed", decision });
  });

  it("terminates a live accepted launch that no longer owns its durable claim", async () => {
    mocks.getSubagentRunByRunId.mockReturnValue({
      childSessionKey: "agent:reviewer:subagent:stale-child",
    });
    await taskReviewerRuntime.settleNonOwningLaunch?.({
      reviewerRunId: "stale-run",
      childSessionKey: "agent:reviewer:subagent:stale-child",
    });
    expect(mocks.killSubagentRunAdmin).toHaveBeenCalledWith({
      cfg: {},
      sessionKey: "agent:reviewer:subagent:stale-child",
    });
  });
});

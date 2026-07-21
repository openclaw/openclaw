// Verifies /wrap authorization, flow selection, continuity, and idempotent status replies.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

const mocks = vi.hoisted(() => ({
  dispatchTaskReview: vi.fn(),
  findReviewSourceTask: vi.fn(),
  parseTaskReviewRequest: vi.fn(),
  resolveWrapReviewFlow: vi.fn(),
  taskReviewerRuntime: { launch: vi.fn(), inspect: vi.fn() },
}));

vi.mock("./commands-wrap.runtime.js", () => mocks);

const { handleWrapCommand } = await import("./commands-wrap.js");

const request = {
  reviewerAgentId: "reviewer",
  staleAfterMs: 60_000,
  maxRecoveryAttempts: 2,
  proofBundle: {
    commit: "1".repeat(40),
    baseCommit: "2".repeat(40),
    diff: { sha256: "3".repeat(64), summary: "review", files: ["src/review.ts"] },
    tests: [],
    screenshots: [],
    criteria: [{ id: "criterion-1", description: "durable" }],
  },
};

function buildParams(commandBodyNormalized = "/wrap"): HandleCommandsParams {
  return {
    cfg: {},
    ctx: { CommandBody: commandBodyNormalized },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      channel: "whatsapp",
      ownerList: [],
    },
    sessionKey: "agent:main:main",
    sessionEntry: {
      sessionId: "session-after-compact",
      compactionCount: 4,
      updatedAt: 1,
    },
  } as unknown as HandleCommandsParams;
}

describe("handleWrapCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWrapReviewFlow.mockReturnValue({
      flowId: "flow-1",
      ownerKey: "agent:main:main",
      syncMode: "managed",
    });
    mocks.parseTaskReviewRequest.mockReturnValue(request);
    mocks.findReviewSourceTask.mockReturnValue({ taskId: "source-task" });
    mocks.dispatchTaskReview.mockReturnValue({
      ok: true,
      created: true,
      task: { taskId: "review-task" },
      detail: {
        state: "review_pending",
        reviewerAgentId: "reviewer",
        proofBundle: request.proofBundle,
      },
    });
  });

  it("ignores unrelated and unauthorized commands", async () => {
    expect(await handleWrapCommand(buildParams("/status"), true)).toBeNull();
    const unauthorized = buildParams();
    unauthorized.command.isAuthorizedSender = false;
    expect(await handleWrapCommand(unauthorized, true)).toEqual({ shouldContinue: false });
    expect(mocks.dispatchTaskReview).not.toHaveBeenCalled();
  });

  it("dispatches the configured reviewer with flow, source-task, and compacted session continuity", async () => {
    const result = await handleWrapCommand(buildParams("/wrap flow-1"), true);

    expect(mocks.resolveWrapReviewFlow).toHaveBeenCalledWith({
      ownerKey: "agent:main:main",
      flowId: "flow-1",
    });
    expect(mocks.dispatchTaskReview).toHaveBeenCalledWith({
      flowId: "flow-1",
      callerOwnerKey: "agent:main:main",
      request,
      continuity: {
        ownerKey: "agent:main:main",
        sessionKey: "agent:main:main",
        sessionId: "session-after-compact",
        compactionCount: 4,
        sourceTaskId: "source-task",
      },
      parentTaskId: "source-task",
      runtime: mocks.taskReviewerRuntime,
    });
    expect(result?.reply?.text).toContain("Review dispatched.");
    expect(result?.reply?.text).toContain(`Commit: ${request.proofBundle.commit}.`);
  });

  it("reports the durable state when a duplicate /wrap reuses the same handoff", async () => {
    mocks.dispatchTaskReview.mockReturnValueOnce({
      ok: true,
      created: false,
      task: { taskId: "review-task" },
      detail: {
        state: "recovery_pending",
        reviewerAgentId: "reviewer",
        proofBundle: request.proofBundle,
      },
    });

    const result = await handleWrapCommand(buildParams(), true);

    expect(result?.reply?.text).toContain("reusing durable handoff");
    expect(result?.reply?.text).toContain("State: recovery_pending.");
  });

  it("fails closed for missing managed flows and invalid review configuration", async () => {
    mocks.resolveWrapReviewFlow.mockReturnValueOnce(undefined);
    const missing = await handleWrapCommand(buildParams(), true);
    expect(missing?.reply?.text).toContain("no active managed TaskFlow");

    mocks.parseTaskReviewRequest.mockImplementationOnce(() => {
      throw new Error("reviewerAgentId is required.");
    });
    const invalid = await handleWrapCommand(buildParams(), true);
    expect(invalid?.reply?.text).toContain("reviewerAgentId is required");
  });
});

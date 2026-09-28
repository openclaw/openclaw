import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { CreatedDetachedTaskRun } from "./detached-task-runtime-contract.js";
import {
  TaskFollowupCompletion,
  getFollowupForCohort,
  promoteFollowupYield,
} from "./task-followup-completion.js";
import type { TaskRunOwner } from "./task-run-owner.types.js";
const cancelCohort = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./task-followup-cancellation.js", () => ({ cancelFollowupCohort: cancelCohort }));
import { transferFollowupCohort } from "./task-followup-cohort.js";
beforeEach(() => {
  cancelCohort.mockReset().mockResolvedValue();
});
const owners = vi.hoisted(() => new Map<string, TaskRunOwner>());
vi.mock("./task-run-owner.js", () => ({
  getTaskRunOwner: (task: { taskId: string }) => owners.get(task.taskId),
}));
const opened: TaskFollowupCompletion[] = [];
afterEach(() => {
  for (const owner of opened.splice(0)) {
    owner.close();
  }
  owners.clear();
  vi.useRealTimers();
});
async function fixture() {
  const controller = new AbortController();
  const release = vi.fn();
  const receipt: CreatedDetachedTaskRun = {
    task: {
      taskId: "followup",
      runtime: "cli",
      ownerKey: "A",
      requesterSessionKey: "A",
      scopeKind: "session",
      childSessionKey: "B",
      runId: "first",
      task: "request",
      status: "running",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      createdAt: 1,
    },
    async bindRunOwner(cancel, assertCurrent) {
      assertCurrent();
      const owner = {
        task: this.task,
        cancel,
        readCurrent: () => this.task,
        resumeExecution: async (assertExecutionCurrent: () => void) => assertExecutionCurrent(),
      };
      owners.set(this.task.taskId, owner);
      return {
        owner,
        release: () => {
          if (owners.get(this.task.taskId) === owner) {
            owners.delete(this.task.taskId);
          }
        },
      };
    },
    finalizeActive: vi.fn(async (terminal, canSettle) => {
      expect(canSettle(receipt.task)).toBe(true);
      Object.assign(receipt.task, terminal);
    }),
    settleUnstarted: vi.fn(async () => true),
  };
  const owner = await TaskFollowupCompletion.bind(
    {
      runId: "first",
      requesterSessionKey: "A",
      requesterSessionId: "A-session",
      requesterAgentId: "main",
      targetAgentId: "main",
      targetSessionKey: "B",
      custody: {
        signal: controller.signal,
        release,
        assertCurrent: () => controller.signal.throwIfAborted(),
        run: (run) => {
          controller.signal.throwIfAborted();
          return run();
        },
      },
    },
    receipt,
  );
  owner.markAccepted("first");
  opened.push(owner);
  return { owner, receipt, controller, release };
}
function child(generation = 1): SubagentRunRecord {
  return {
    runId: "C",
    childSessionKey: "C-session",
    requesterSessionKey: "B",
    requesterDisplayKey: "B",
    task: "nested",
    cleanup: "keep",
    createdAt: 2,
    execution: { status: "terminal", endedAt: 3, outcome: { status: "ok" } },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: generation,
      batchRunIds: ["C"],
    },
  };
}
async function settleExecution(
  owner: TaskFollowupCompletion,
  runId: string,
  reply: Parameters<TaskFollowupCompletion["settle"]>[1],
) {
  await owner.settle(runId, reply);
  owner.finishExecution(runId);
}
const final = {
  status: "ok" as const,
  endedAt: 4,
  terminalReply: { disposition: "visible" as const, text: "B_DONE" },
  replyText: "B_DONE",
};
describe("task-owned followup completion", () => {
  it("requires a fresh committed cohort when an admitted successor yields again", async () => {
    const f = await fixture();
    const c = child();
    f.owner.promoteYield("first", [c], 1);
    await settleExecution(f.owner, "first", { status: "ok", yielded: true });
    const next = f.owner.successor([c], "second", () => {});
    await f.owner.prepareSuccessor(next);
    f.owner.adopt(next);
    await settleExecution(f.owner, "second", { status: "ok", yielded: true });
    await expect(f.owner.take()).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("without a committed"),
    });
    expect(f.receipt.task.status).toBe("failed");
  });
  it("cancels the logical yielded task without admitting its successor", async () => {
    const f = await fixture();
    const c = child();
    f.owner.promoteYield("first", [c], 1);
    await settleExecution(f.owner, "first", { status: "ok", yielded: true });
    const result = await owners.get("followup")!.cancel("Stopped by requester");
    expect(result.ok).toBe(true);
    expect(cancelCohort).toHaveBeenCalledWith(expect.objectContaining({ entries: [c] }));
    expect(f.receipt.task.status).toBe("cancelled");
    expect(() => f.owner.successor([c], "second", () => {})).toThrow("cancellation");
    await expect(f.owner.take()).resolves.toMatchObject({ status: "error", stopReason: "rpc" });
  });
  it("retains an incomplete cancellation intent and permits explicit cancellation reconciliation", async () => {
    const f = await fixture();
    const c = child();
    f.owner.promoteYield("first", [c], 1);
    await settleExecution(f.owner, "first", { status: "ok", yielded: true });
    cancelCohort.mockRejectedValueOnce(new Error("Child stop outcome unknown"));
    await expect(owners.get("followup")!.cancel("stop")).resolves.toMatchObject({ ok: false });
    expect(f.receipt.task.status).toBe("running");
    expect(() => f.owner.successor([c], "second", () => {})).toThrow("cancellation");
    await expect(owners.get("followup")!.cancel("stop")).resolves.toMatchObject({ ok: true });
  });
  it("follows only the canonical child's same-task replacement and rolls it back atomically", async () => {
    const f = await fixture();
    const c = child();
    f.owner.promoteYield("first", [c], 1);
    const next = { ...c, runId: "C-next", taskRunId: c.runId };
    const rollback = transferFollowupCohort(c, next);
    expect(getFollowupForCohort([next])).toBe(f.owner);
    expect(() => f.owner.successor([next], "second", () => {})).not.toThrow();
    rollback();
    expect(() => f.owner.successor([next], "second", () => {})).toThrow("cohort");
    expect(() => f.owner.successor([c], "second", () => {})).not.toThrow();
  });
  it("publishes only after the physical execution releases, without releasing the task at yield", async () => {
    const f = await fixture();
    let published = false;
    const taken = f.owner.take().then(() => {
      published = true;
    });
    await f.owner.settle("first", final);
    await Promise.resolve();
    expect(published).toBe(false);
    f.owner.finishExecution("first");
    await taken;
    expect(published).toBe(true);
  });
  it("returns a non-yielding final once through the existing receipt", async () => {
    const f = await fixture();
    await settleExecution(f.owner, "first", final);
    await expect(f.owner.take()).resolves.toEqual(final);
    await expect(f.owner.take()).rejects.toThrow("consumer");
    expect(f.receipt.finalizeActive).toHaveBeenCalledTimes(1);
  });
  it("keeps an empty yielded predecessor pending until its exact admitted successor finishes", async () => {
    const f = await fixture();
    const c = child();
    promoteFollowupYield({ requesterTurnRunId: "first", entries: [c], rearmGeneration: 1 });
    await settleExecution(f.owner, "first", {
      status: "ok",
      yielded: true,
      terminalReply: { disposition: "empty" },
    });
    expect(f.receipt.finalizeActive).not.toHaveBeenCalled();
    const successor = f.owner.successor([c], "second", () => {});
    await f.owner.prepareSuccessor(successor);
    f.owner.adopt(successor);
    await expect(f.owner.settle("unrelated", final)).rejects.toThrow("replaced");
    await settleExecution(f.owner, "second", final);
    await expect(f.owner.take()).resolves.toEqual(final);
    expect(f.receipt.task.runId).toBe("first");
    expect(f.receipt.finalizeActive).toHaveBeenCalledTimes(1);
  });
  it("transfers an inline timeout to one asynchronous consumer across repeated yields", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const inline = f.owner.take(10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(inline).resolves.toBeUndefined();
    const asynchronous = f.owner.take();
    for (const [runId, nextRunId, generation] of [
      ["first", "second", 1],
      ["second", "third", 2],
    ] as const) {
      const c = child(generation);
      promoteFollowupYield({
        requesterTurnRunId: runId,
        entries: [c],
        rearmGeneration: generation,
      });
      await settleExecution(f.owner, runId, { status: "ok", yielded: true });
      const successor = f.owner.successor([c], nextRunId, () => {});
      await f.owner.prepareSuccessor(successor);
      f.owner.adopt(successor);
    }
    await settleExecution(f.owner, "third", final);
    await expect(asynchronous).resolves.toEqual(final);
    expect(f.receipt.finalizeActive).toHaveBeenCalledTimes(1);
  });
});

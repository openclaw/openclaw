import { expect, it, vi } from "vitest";
import { createQueueCase } from "./queue.case.test-support.js";
import { createQueueTestRun as createRun } from "./queue.test-helpers.js";
import type { FollowupRun, QueuedFollowupReplyBatch } from "./queue/types.js";

export function registerCollectedReplyCustodyCases(): void {
  it("settles every collected source while publishing content once", async () => {
    const q = createQueueCase();
    const first = vi.fn();
    const last = vi.fn();
    const recovery = vi.fn();
    const firstRetry = vi.fn(() => vi.fn());
    const lastRetry = vi.fn(() => recovery);
    const readAdmissionConfig = () => ({ commands: { ownerAllowFrom: ["latest-owner"] } });
    for (const [prompt, deliver, createSourceRetry] of [
      ["first", first, firstRetry],
      ["last", last, lastRetry],
    ] as const) {
      q.add({
        ...createRun({ prompt, originatingChannel: "webchat" }),
        readAdmissionConfig,
        queuedFollowupReplyDisposition: {
          kind: "deliver",
          deliver: Object.assign(deliver, {
            ownsCompletion: (channel: string | undefined) => channel === "webchat",
            createSourceRetry,
          }),
        },
      });
    }
    await q.drain();
    expect(q.calls).toHaveLength(1);
    expect(q.calls[0]?.readAdmissionConfig?.()).toEqual(readAdmissionConfig());
    const owner = q.calls[0]?.queuedFollowupReplyDisposition;
    if (owner?.kind !== "deliver") {
      throw new Error("Collected execution lost its source delivery owner");
    }
    expect(first).not.toHaveBeenCalled();
    expect(last).not.toHaveBeenCalled();
    expect(owner.deliver.ownsCompletion?.("webchat")).toBe(true);
    expect(owner.deliver.ownsCompletion?.("discord")).toBe(false);
    const progress: QueuedFollowupReplyBatch = {
      kind: "queued-followup",
      runId: "batch-execution",
      originatingChannel: "webchat",
      payloads: [{ text: "working" }],
      completion: { kind: "progress" },
    };
    await owner.deliver(progress);
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledExactlyOnceWith(progress);
    const terminal: QueuedFollowupReplyBatch = {
      ...progress,
      payloads: [{ text: "done" }],
      completion: { kind: "completed", stopReason: "stop" },
    };
    await owner.deliver(terminal);
    expect(first).toHaveBeenCalledExactlyOnceWith({ ...terminal, payloads: [] });
    expect(last).toHaveBeenCalledTimes(2);
    expect(last).toHaveBeenLastCalledWith(terminal);
    const retry = owner.deliver.createSourceRetry?.();
    await retry?.({ ...terminal, runId: "recovery-execution" });
    expect(firstRetry).not.toHaveBeenCalled();
    expect(lastRetry).toHaveBeenCalledOnce();
    expect(recovery).toHaveBeenCalledExactlyOnceWith({
      ...terminal,
      runId: "recovery-execution",
    });
    expect(first).toHaveBeenCalledOnce();
  });
}

export function registerOverflowRetryCustodyCase(): void {
  it("does not re-deliver overflow summary on partial auth group failure retry", async () => {
    const q = createQueueCase({ cap: 2 }, 1);
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1; // Summary succeeds (attempt 1), first group fails (attempt 2), then
      // both retained authorization groups succeed on retry.
      if (attempt === 2) {
        throw new Error("transient failure");
      }
      q.calls.push(run);
      if (q.calls.length >= 3) {
        q.done.resolve();
      }
    };
    const guest = { senderId: "user-1", senderName: "Guest", senderIsOwner: false };
    const readAdmissionConfig = () => ({ commands: { ownerAllowFrom: ["queued-owner"] } });
    const dropped = createRun({
      prompt: "dropped guest message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    Object.assign(dropped.run, guest);
    dropped.readAdmissionConfig = readAdmissionConfig;
    q.add(dropped);
    q.slack("guest message", guest);
    q.slack("owner message", { senderId: "owner-1", senderName: "Owner", senderIsOwner: true });
    await q.drain(runFollowup);
    expect(q.calls).toHaveLength(3);
    expect(q.calls.map((run) => [run.run.senderId, run.run.senderIsOwner])).toEqual([
      ["user-1", false],
      ["user-1", false],
      ["owner-1", true],
    ]);
    expect(q.calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(q.calls[0]?.readAdmissionConfig?.()).toEqual(readAdmissionConfig());
    expect(q.calls[0]?.prompt).toContain("- dropped guest message");
    expect(q.calls[1]?.prompt).not.toContain("[Queue overflow]");
    expect(q.calls[1]?.prompt).not.toContain("dropped guest message");
    expect(q.calls[1]?.prompt).toContain("guest message");
    expect(q.calls[2]?.prompt).not.toContain("[Queue overflow]");
    expect(q.calls[2]?.prompt).toContain("owner message");
  });
}

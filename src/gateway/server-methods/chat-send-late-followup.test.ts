import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createChatSendLateFollowupDisposition } from "./chat-send-late-followup.js";

function createFixture(originatingChannel = "webchat") {
  const info = vi.fn();
  const deliver = vi.fn(async () => ({ kind: "delivered" as const }));
  const disposition = createChatSendLateFollowupDisposition({
    runId: "original-run",
    originatingChannel,
    logGateway: { info } as never,
    deliver,
  });
  const expectDrop = (reason: string, outcome?: string) =>
    expect(info).toHaveBeenCalledWith(
      "webchat late reply disposition",
      expect.objectContaining({ reason, ...(outcome ? { outcome } : {}) }),
    );
  return { expectDrop, deliver, disposition };
}

function batch(runId: string, originatingChannel = "webchat") {
  return {
    kind: "queued-followup" as const,
    completion: { kind: "completed" as const },
    runId,
    originatingChannel,
    payloads: [{ text: runId }],
  };
}

describe("chat.send late queued follow-up disposition", () => {
  it("keeps progress open and includes its payloads in terminal delivery", async () => {
    const { deliver, disposition } = createFixture();
    expect(disposition.deliver.ownsCompletion("webchat")).toBe(false);
    disposition.recordQueued();
    expect(disposition.deliver.ownsCompletion("discord")).toBe(false);
    const progress = {
      ...batch("followup-run"),
      payloads: [{ text: "working", mediaUrl: "https://example.test/progress.png" }],
      completion: { kind: "progress" as const },
    };
    await disposition.deliver(progress);
    expect(disposition.deliver.ownsCompletion("webchat")).toBe(true);
    await disposition.deliver({
      ...progress,
      payloads: [{ text: "done" }],
      completion: { kind: "completed" },
    });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runId: "followup-run",
        clientRunId: "original-run",
        completion: { kind: "completed" },
        payloads: [...progress.payloads, { text: "done" }],
      }),
    );
    expect(disposition.deliver.ownsCompletion("webchat")).toBe(false);
  });

  it.each([
    ["discord", "discord", "non-webchat-origin"],
    ["webchat", "discord", "origin-mismatch"],
  ])("records an explicit drop for %s -> %s", async (originatingChannel, batchChannel, reason) => {
    const { expectDrop, deliver, disposition } = createFixture(originatingChannel);
    disposition.recordQueued();
    await disposition.deliver(batch("must not leak", batchChannel));
    expect(deliver).not.toHaveBeenCalled();
    expectDrop(reason, "late-and-dropped");
  });

  it("gives a pending source's only delivery to the retry it hands off to", async () => {
    const { deliver, disposition: source } = createFixture();
    const retry = source.deliver.createSourceRetry();
    // A late deferral of the original source cannot reopen its delivery.
    source.recordQueued();
    await source.deliver(batch("source-run"));
    await retry(batch("recovery-run"));
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: "recovery-run", clientRunId: "recovery-run" }),
    );
    expect(() => source.deliver.createSourceRetry()).toThrow();
  });

  it("claims delivery before awaiting and records a concurrent duplicate", async () => {
    const { expectDrop, deliver, disposition } = createFixture();
    const delivery = createDeferred<{ kind: "delivered" }>();
    deliver.mockImplementation(() => delivery.promise);
    disposition.recordQueued();
    const first = disposition.deliver(batch("first-followup"));
    await disposition.deliver(batch("duplicate-followup"));
    expect(deliver).toHaveBeenCalledOnce();
    expectDrop("delivery-in-flight");
    delivery.resolve({ kind: "delivered" });
    await first;
  });

  it("settles a failed delivery and rejects every subsequent attempt", async () => {
    const { expectDrop, deliver, disposition } = createFixture();
    deliver.mockRejectedValue(new Error("broadcast failed"));
    disposition.recordQueued();
    await expect(disposition.deliver(batch("failed-followup"))).rejects.toThrow("broadcast failed");
    await disposition.deliver(batch("retry"));
    expectDrop("delivery-failed");
    expectDrop("already-settled");
    expect(deliver).toHaveBeenCalledOnce();
  });
});

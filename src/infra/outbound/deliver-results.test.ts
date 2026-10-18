import { describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import { createDeliveryResultRecorder } from "./deliver-results.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";

describe("delivery result reconciliation", () => {
  it("consumes progress once across aggregate receipts and identity-only final results", async () => {
    const first = { channel: "line", messageId: "push", meta: { position: "first" } };
    const otherChannel = { channel: "matrix", messageId: "push" };
    const second = { channel: "line", messageId: "push", meta: { position: "second" } };
    const last = { channel: "line", messageId: "push", meta: { position: "last" } };
    const progress = [first, otherChannel, second, last];
    const aggregate = {
      channel: "line",
      messageId: "push",
      receipt: createMessageReceiptFromOutboundResults({ results: [first, second] }),
    };
    const identityOnly = { channel: "line", messageId: "push", meta: { finalized: true } };
    const unreported = { channel: "line", messageId: "new" };
    const results: OutboundDeliveryResult[] = [];
    const onDeliveryResult = vi.fn();
    const recorder = createDeliveryResultRecorder({ results, onDeliveryResult });
    for (const result of progress) {
      await recorder.reportIdentifiedDeliveryResult(result);
    }

    await expect(
      recorder.recordIdentifiedDeliveryResults([aggregate, identityOnly, unreported]),
    ).resolves.toEqual([true, true, true]);

    expect(results).toEqual([aggregate, otherChannel, identityOnly, unreported]);
    expect(onDeliveryResult.mock.calls.map(([result]) => result)).toEqual([
      ...progress,
      unreported,
    ]);
  });

  it("attaches a scalar aggregate to the latest matching progress without erasing earlier sends", async () => {
    const first = { channel: "line", messageId: "push", meta: { position: "first" } };
    const second = { channel: "line", messageId: "push", meta: { position: "second" } };
    const last = { channel: "line", messageId: "push", meta: { position: "last" } };
    const aggregate = {
      channel: "line",
      messageId: "push",
      receipt: createMessageReceiptFromOutboundResults({ results: [second, last] }),
    };
    const results: OutboundDeliveryResult[] = [];
    const recorder = createDeliveryResultRecorder({ results });
    for (const result of [first, second, last]) {
      await recorder.reportIdentifiedDeliveryResult(result);
    }

    await expect(recorder.recordIdentifiedDeliveryResult(aggregate)).resolves.toBe(true);

    expect(results).toEqual([first, aggregate]);
  });

  it("retains immutable placement across reconciliation, aliases and payload reset", async () => {
    const nested = { roomId: "reported-room", threadId: "reported-thread" };
    const progress = { channel: "matrix", messageId: "m", raw: [nested] };
    const final: OutboundDeliveryResult = {
      channel: "matrix",
      messageId: "m",
      meta: { hookOwner: true },
    };
    const results: OutboundDeliveryResult[] = [];
    const onDeliveryResult = vi.fn(() => {
      nested.roomId = "observer-mutation";
    });
    const recorder = createDeliveryResultRecorder({ results, onDeliveryResult });
    await recorder.reportIdentifiedDeliveryResult(progress);
    const first = recorder.getReportedPlacement();
    nested.threadId = "provider-mutation";
    await recorder.recordIdentifiedDeliveryResult(final);
    expect(results).toEqual([final]);
    expect(results[0]).toBe(final);
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(first).toEqual({
      channels: ["matrix"],
      targets: ["reported-room"],
      threads: ["reported-thread"],
      invalid: false,
    });
    expect(recorder.getReportedPlacement()).toEqual(first);
    expect(Object.isFrozen(first.channels)).toBe(true);
    expect(Object.isFrozen(first.targets)).toBe(true);
    recorder.resetPayloadResults();
    await recorder.reportIdentifiedDeliveryResult({
      channel: "matrix",
      messageId: "m",
      target: { kind: "room", id: "next-room" },
    });
    expect(recorder.getReportedPlacement()).toEqual({
      channels: ["matrix"],
      targets: ["next-room"],
      threads: [],
      invalid: false,
    });
    expect(results).toHaveLength(2);
  });
});

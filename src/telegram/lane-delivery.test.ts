import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../auto-reply/types.js";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";
import { createLaneTextDeliverer, type DraftLaneState, type LaneName } from "./lane-delivery.js";

function createHarness(params?: {
  answerMessageId?: number;
  draftMaxChars?: number;
  answerMessageIdAfterStop?: number;
  answerStream?: DraftLaneState["stream"];
  answerHasStreamedMessage?: boolean;
  answerLastPartialText?: string;
  answerPreviewRevisionBaseline?: number;
}) {
  const answer =
    params?.answerStream ?? createTestDraftStream({ messageId: params?.answerMessageId });
  const reasoning = createTestDraftStream();
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: {
      stream: answer,
      lastPartialText: params?.answerLastPartialText ?? "",
      hasStreamedMessage: params?.answerHasStreamedMessage ?? false,
      previewRevisionBaseline: params?.answerPreviewRevisionBaseline ?? 0,
    },
    reasoning: {
      stream: reasoning as DraftLaneState["stream"],
      lastPartialText: "",
      hasStreamedMessage: false,
      previewRevisionBaseline: 0,
    },
  };
  const sendPayload = vi.fn().mockResolvedValue(true);
  const flushDraftLane = vi.fn().mockImplementation(async (lane: DraftLaneState) => {
    await lane.stream?.flush();
  });
  const stopDraftLane = vi.fn().mockImplementation(async (lane: DraftLaneState) => {
    if (lane === lanes.answer && params?.answerMessageIdAfterStop !== undefined) {
      (answer as { setMessageId?: (value: number | undefined) => void }).setMessageId?.(
        params.answerMessageIdAfterStop,
      );
    }
    await lane.stream?.stop();
  });
  const editPreview = vi.fn().mockResolvedValue(undefined);
  const deletePreviewMessage = vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();
  const markDelivered = vi.fn();
  const finalizedPreviewByLane: Record<LaneName, boolean> = { answer: false, reasoning: false };
  const archivedAnswerPreviews: Array<{ messageId: number; textSnapshot: string }> = [];

  const deliverLaneText = createLaneTextDeliverer({
    lanes,
    archivedAnswerPreviews,
    finalizedPreviewByLane,
    draftMaxChars: params?.draftMaxChars ?? 4_096,
    applyTextToPayload: (payload: ReplyPayload, text: string) => ({ ...payload, text }),
    sendPayload,
    flushDraftLane,
    stopDraftLane,
    editPreview,
    deletePreviewMessage,
    log,
    markDelivered,
  });

  return {
    deliverLaneText,
    lanes,
    answer: {
      stream: answer,
      setMessageId: (answer as { setMessageId?: (value: number | undefined) => void }).setMessageId,
    },
    sendPayload,
    flushDraftLane,
    stopDraftLane,
    editPreview,
    log,
    markDelivered,
  };
}

describe("createLaneTextDeliverer", () => {
  it("finalizes text-only replies by editing an existing preview message", async () => {
    const harness = createHarness({ answerMessageId: 999 });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Hello final",
      payload: { text: "Hello final" },
      infoKind: "final",
    });

    expect(result).toBe("preview-finalized");
    expect(harness.editPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        laneName: "answer",
        messageId: 999,
        text: "Hello final",
        context: "final",
      }),
    );
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.stopDraftLane).toHaveBeenCalledTimes(1);
  });

  it("primes stop-created previews with final text before editing", async () => {
    const harness = createHarness({ answerMessageIdAfterStop: 777 });
    harness.lanes.answer.lastPartialText = "no";

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "no problem",
      payload: { text: "no problem" },
      infoKind: "final",
    });

    expect(result).toBe("preview-finalized");
    expect(harness.answer.stream?.update).toHaveBeenCalledWith("no problem");
    expect(harness.editPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        laneName: "answer",
        messageId: 777,
        text: "no problem",
      }),
    );
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("treats stop-created preview edit failures as delivered", async () => {
    const harness = createHarness({ answerMessageIdAfterStop: 777 });
    harness.editPreview.mockRejectedValue(new Error("500: edit failed after stop flush"));

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Short final",
      payload: { text: "Short final" },
      infoKind: "final",
    });

    expect(result).toBe("preview-finalized");
    expect(harness.editPreview).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("treating as delivered"));
  });

  it("falls back to normal delivery when editing an existing preview fails", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.editPreview.mockRejectedValue(new Error("500: preview edit failed"));

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Hello final",
      payload: { text: "Hello final" },
      infoKind: "final",
    });

    expect(result).toBe("sent");
    expect(harness.editPreview).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello final" }),
    );
  });

  it("falls back to normal delivery when stop-created preview has no message id", async () => {
    const harness = createHarness();

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Short final",
      payload: { text: "Short final" },
      infoKind: "final",
    });

    expect(result).toBe("sent");
    expect(harness.editPreview).not.toHaveBeenCalled();
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Short final" }),
    );
  });

  it("keeps existing preview when final text regresses", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.lastPartialText = "Recovered final answer.";

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Recovered final answer",
      payload: { text: "Recovered final answer" },
      infoKind: "final",
    });

    expect(result).toBe("preview-finalized");
    expect(harness.editPreview).not.toHaveBeenCalled();
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal delivery when final text exceeds preview edit limit", async () => {
    const harness = createHarness({ answerMessageId: 999, draftMaxChars: 20 });
    const longText = "x".repeat(50);

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: longText,
      payload: { text: longText },
      infoKind: "final",
    });

    expect(result).toBe("sent");
    expect(harness.editPreview).not.toHaveBeenCalled();
    expect(harness.sendPayload).toHaveBeenCalledWith(expect.objectContaining({ text: longText }));
    expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("preview final too long"));
  });

  it("treats unchanged DM draft final text as already finalized", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    answerStream.previewRevision.mockReturnValue(7);
    answerStream.lastDeliveredText.mockReturnValue("Hello final");
    answerStream.update.mockImplementation(() => {});
    const harness = createHarness({
      answerStream: answerStream as DraftLaneState["stream"],
      answerHasStreamedMessage: true,
      answerLastPartialText: "Hello final",
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Hello final",
      payload: { text: "Hello final" },
      infoKind: "final",
    });

    expect(result).toBe("preview-finalized");
    expect(harness.flushDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.stopDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("falls back once when DM draft finalization emits no update", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    answerStream.previewRevision.mockReturnValue(3);
    answerStream.update.mockImplementation(() => {});
    const harness = createHarness({
      answerStream: answerStream as DraftLaneState["stream"],
      answerHasStreamedMessage: true,
      answerLastPartialText: "Partial",
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Final answer",
      payload: { text: "Final answer" },
      infoKind: "final",
    });

    expect(result).toBe("sent");
    expect(harness.flushDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.stopDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Final answer" }),
    );
    expect(harness.markDelivered).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining("draft final text not emitted"),
    );
  });

  it("falls back when unchanged final text has no emitted draft preview in current lane", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    answerStream.previewRevision.mockReturnValue(7);
    answerStream.update.mockImplementation(() => {});
    const harness = createHarness({
      answerStream: answerStream as DraftLaneState["stream"],
      answerHasStreamedMessage: true,
      answerLastPartialText: "Hello final",
      answerPreviewRevisionBaseline: 7,
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Hello final",
      payload: { text: "Hello final" },
      infoKind: "final",
    });

    expect(result).toBe("sent");
    expect(harness.stopDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello final" }),
    );
    expect(harness.markDelivered).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining("draft final text not emitted"),
    );
  });

  it("falls back when revision advances but final text was not emitted", async () => {
    let previewRevision = 7;
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    answerStream.previewRevision.mockImplementation(() => previewRevision);
    answerStream.lastDeliveredText.mockReturnValue("Older partial");
    answerStream.update.mockImplementation(() => {});
    answerStream.flush.mockImplementation(async () => {
      previewRevision += 1;
    });
    const harness = createHarness({
      answerStream: answerStream as DraftLaneState["stream"],
      answerHasStreamedMessage: true,
      answerLastPartialText: "Final answer",
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Final answer",
      payload: { text: "Final answer" },
      infoKind: "final",
    });

    expect(result).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Final answer" }),
    );
    expect(harness.markDelivered).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining("draft final text not emitted"),
    );
  });

  it("does not use DM draft final shortcut for media payloads", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    const harness = createHarness({
      answerStream: answerStream as DraftLaneState["stream"],
      answerHasStreamedMessage: true,
      answerLastPartialText: "Image incoming",
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Image incoming",
      payload: { text: "Image incoming", mediaUrl: "file:///tmp/example.png" },
      infoKind: "final",
    });

    expect(result).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Image incoming", mediaUrl: "file:///tmp/example.png" }),
    );
    expect(harness.markDelivered).not.toHaveBeenCalled();
  });

  it("does not use DM draft final shortcut when inline buttons are present", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    const harness = createHarness({
      answerStream: answerStream as DraftLaneState["stream"],
      answerHasStreamedMessage: true,
      answerLastPartialText: "Choose one",
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Choose one",
      payload: { text: "Choose one" },
      previewButtons: [[{ text: "OK", callback_data: "ok" }]],
      infoKind: "final",
    });

    expect(result).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Choose one" }),
    );
    expect(harness.markDelivered).not.toHaveBeenCalled();
  });
});

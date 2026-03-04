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
}) {
  const answer =
    params?.answerStream ?? createTestDraftStream({ messageId: params?.answerMessageId });
  const reasoning = createTestDraftStream();
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: {
      stream: answer,
      lastPartialText: params?.answerLastPartialText ?? "",
      hasStreamedMessage: params?.answerHasStreamedMessage ?? false,
    },
    reasoning: {
      stream: reasoning as DraftLaneState["stream"],
      lastPartialText: "",
      hasStreamedMessage: false,
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
  const archivedAnswerPreviews: Array<{
    messageId: number;
    textSnapshot: string;
    deleteIfUnused?: boolean;
  }> = [];

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
    deletePreviewMessage,
    log,
    markDelivered,
    archivedAnswerPreviews,
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

  it("sends a final message after DM draft streaming even when text is unchanged", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft" });
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

    expect(result).toBe("sent");
    expect(harness.flushDraftLane).toHaveBeenCalled();
    expect(harness.stopDraftLane).toHaveBeenCalled();
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello final" }),
    );
    expect(harness.markDelivered).not.toHaveBeenCalled();
  });

  it("sends a final message after DM draft streaming when revision changes", async () => {
    let previewRevision = 3;
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    answerStream.previewRevision.mockImplementation(() => previewRevision);
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

  it("deletes consumed boundary previews after fallback final send", async () => {
    const harness = createHarness();
    harness.archivedAnswerPreviews.push({
      messageId: 4444,
      textSnapshot: "Boundary preview",
      deleteIfUnused: false,
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Final with media",
      payload: { text: "Final with media", mediaUrl: "file:///tmp/example.png" },
      infoKind: "final",
    });

    expect(result).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Final with media", mediaUrl: "file:///tmp/example.png" }),
    );
    expect(harness.deletePreviewMessage).toHaveBeenCalledWith(4444);
  });
});

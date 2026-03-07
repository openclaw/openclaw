import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../auto-reply/types.js";
import { createLaneTextDeliverer, type DraftLaneState } from "./lane-delivery.js";

function createMockLane(hasStream = false): DraftLaneState {
  return {
    stream: hasStream
      ? ({
          messageId: () => 42,
          update: vi.fn(),
          stop: vi.fn(),
          flush: vi.fn(),
        } as unknown as DraftLaneState["stream"])
      : undefined,
    lastPartialText: "",
    hasStreamedMessage: false,
  };
}

function createDeliverer(overrides?: { sendResult?: boolean }) {
  const sendPayload = vi.fn().mockResolvedValue(overrides?.sendResult ?? true);
  const editPreview = vi.fn().mockResolvedValue(undefined);
  const flushDraftLane = vi.fn().mockResolvedValue(undefined);
  const stopDraftLane = vi.fn().mockResolvedValue(undefined);
  const deletePreviewMessage = vi.fn().mockResolvedValue(undefined);
  const markDelivered = vi.fn();
  const log = vi.fn();
  const answerLane = createMockLane(true);

  const deliver = createLaneTextDeliverer({
    lanes: { answer: answerLane, reasoning: createMockLane() },
    archivedAnswerPreviews: [],
    finalizedPreviewByLane: { answer: false, reasoning: false },
    draftMaxChars: 4096,
    applyTextToPayload: (payload, text) => ({ ...payload, text }),
    sendPayload,
    flushDraftLane,
    stopDraftLane,
    editPreview,
    deletePreviewMessage,
    log,
    markDelivered,
  });

  return { deliver, sendPayload, editPreview, stopDraftLane, markDelivered };
}

describe("lane-delivery NO_REPLY suppression", () => {
  it("skips NO_REPLY entirely without sending or editing", async () => {
    const { deliver, editPreview, sendPayload } = createDeliverer();
    const payload: ReplyPayload = { text: "NO_REPLY" };

    const result = await deliver({
      laneName: "answer",
      text: "NO_REPLY",
      payload,
      infoKind: "final",
    });

    // NO_REPLY is suppressed before reaching any delivery path.
    expect(editPreview).not.toHaveBeenCalled();
    expect(sendPayload).not.toHaveBeenCalled();
    expect(result).toBe("skipped");
  });

  it("skips NO_REPLY with whitespace without sending", async () => {
    const { deliver, editPreview, sendPayload } = createDeliverer();
    const payload: ReplyPayload = { text: "  NO_REPLY  " };

    const result = await deliver({
      laneName: "answer",
      text: "  NO_REPLY  ",
      payload,
      infoKind: "final",
    });

    expect(editPreview).not.toHaveBeenCalled();
    expect(sendPayload).not.toHaveBeenCalled();
    expect(result).toBe("skipped");
  });

  it("allows preview edit for substantive text containing NO_REPLY", async () => {
    const { deliver, stopDraftLane } = createDeliverer();
    const text = "The answer is NO_REPLY in this context";
    const payload: ReplyPayload = { text };

    await deliver({
      laneName: "answer",
      text,
      payload,
      infoKind: "final",
    });

    // Substantive text should attempt preview finalization —
    // stopDraftLane is called as part of the preview edit flow.
    expect(stopDraftLane).toHaveBeenCalled();
  });
});

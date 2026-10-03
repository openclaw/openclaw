/**
 * Gateway loopback question-prompt sender: construct only when a channel can
 * receive the prompt, and fail closed when durable delivery did not land.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const sendDurableMessageBatchCore = vi.hoisted(() => vi.fn());

vi.mock("../../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: (...args: unknown[]) => sendDurableMessageBatchCore(...args),
  durableMessageBatchMayHaveReachedRecipient: (result: { status: string }) =>
    result.status === "sent" || result.status === "partial_failed",
}));

import {
  createChannelQuestionPromptDelivery,
  sendQuestionToolPrompt,
} from "./question-prompt-send.js";

const cfg = {} as OpenClawConfig;
const receipt = {
  platformMessageIds: ["m1"],
  parts: [],
  sentAt: 1,
};

describe("createChannelQuestionPromptDelivery", () => {
  beforeEach(() => {
    sendDurableMessageBatchCore.mockReset();
  });

  it("does not invent a sender without a deliverable channel", () => {
    expect(
      createChannelQuestionPromptDelivery({
        cfg,
        channel: "telegram",
      }),
    ).toBeUndefined();
    expect(
      createChannelQuestionPromptDelivery({
        cfg,
        to: "1",
      }),
    ).toBeUndefined();
  });

  it("sends the prompt on the originating channel", async () => {
    sendDurableMessageBatchCore.mockResolvedValueOnce({
      status: "sent",
      results: [],
      receipt,
    });
    const delivery = createChannelQuestionPromptDelivery({
      cfg,
      channel: " TeLeGrAm ",
      to: "1",
      accountId: "default",
    });

    const signal = new AbortController().signal;
    await delivery?.send({ text: "Question for you:" }, { signal });

    expect(sendDurableMessageBatchCore).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "1",
        accountId: "default",
        payloads: [{ text: "Question for you:" }],
        bestEffort: false,
        durability: "required",
        deliveryRetryOwner: "caller",
        signal,
      }),
    );
  });

  it.each([
    ["an explicit ask_user thread", "1700000000.000200", "1700000000.000200"],
    ["the inbound thread when ask_user names none", undefined, "1700000000.000100"],
  ])("posts the prompt in %s", async (_name, threadId, expectedThreadId) => {
    sendDurableMessageBatchCore.mockResolvedValueOnce({
      status: "sent",
      results: [],
      receipt,
    });
    const delivery = createChannelQuestionPromptDelivery({
      cfg,
      channel: "slack",
      to: "C1",
      threadId: "1700000000.000100",
    });

    await sendQuestionToolPrompt({
      toolName: "ask_user",
      questionId: "q1",
      questions: [
        {
          questionId: "deploy_target",
          header: "Target",
          question: "Where should this deploy?",
          options: [{ label: "Staging" }, { label: "Production" }],
          isOther: true,
        },
      ],
      send: delivery!.send,
      threadId,
    });

    expect(sendDurableMessageBatchCore).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "slack", to: "C1", threadId: expectedThreadId }),
    );
  });

  it("asks for a button answer when the prompt moves to another thread", async () => {
    sendDurableMessageBatchCore.mockResolvedValueOnce({ status: "sent", results: [], receipt });
    const delivery = createChannelQuestionPromptDelivery({ cfg, channel: "slack", to: "C1" });

    await sendQuestionToolPrompt({
      toolName: "ask_user",
      questionId: "q1",
      questions: [
        {
          questionId: "deploy_target",
          header: "Target",
          question: "Where should this deploy?",
          options: [{ label: "Staging" }, { label: "Production" }],
          isOther: false,
        },
      ],
      send: delivery!.send,
      threadId: "1700000000.000200",
    });

    const payload = sendDurableMessageBatchCore.mock.lastCall?.[0].payloads[0];
    const [, guidance, buttons] = payload.presentation.blocks;
    expect(payload.text).toMatch(/Answer with the buttons below\.$/);
    expect(payload.text).not.toMatch(/reply/i);
    expect(guidance.text).toMatch(/Answer with the buttons below\.$/);
    expect(buttons.buttons.map((button: { label: string }) => button.label)).toEqual([
      "Staging",
      "Production",
    ]);
  });

  it("rejects a hook-suppressed prompt so the question does not become answerable", async () => {
    sendDurableMessageBatchCore.mockResolvedValueOnce({
      status: "suppressed",
      results: [],
      receipt,
      reason: "cancelled_by_message_sending_hook",
    });
    const delivery = createChannelQuestionPromptDelivery({
      cfg,
      channel: "telegram",
      to: "1",
    });

    await expect(delivery?.send({ text: "claimed elsewhere" })).rejects.toThrow(
      "question prompt delivery was suppressed: cancelled_by_message_sending_hook",
    );
  });

  it("rejects a failed send that never reached the conversation", async () => {
    sendDurableMessageBatchCore.mockResolvedValueOnce({
      status: "failed",
      error: new Error("adapter down"),
    });
    const delivery = createChannelQuestionPromptDelivery({
      cfg,
      channel: "telegram",
      to: "1",
    });

    await expect(delivery?.send({ text: "Question for you:" })).rejects.toThrow("adapter down");
  });

  it("keeps a prompt that already reached the conversation", async () => {
    sendDurableMessageBatchCore.mockResolvedValueOnce({
      status: "partial_failed",
      results: [],
      receipt,
      error: new Error("later part failed"),
      sentBeforeError: true,
    });
    const delivery = createChannelQuestionPromptDelivery({
      cfg,
      channel: "telegram",
      to: "1",
    });

    await expect(delivery?.send({ text: "Question for you:" })).resolves.toBeUndefined();
  });
});

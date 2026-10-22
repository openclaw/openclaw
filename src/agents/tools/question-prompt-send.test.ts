/**
 * Question-prompt senders: the loopback sender constructs only when a channel
 * can receive the prompt, the owner sender reaches the configured owner with
 * an answer surface they can use, and both fail closed when nothing landed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const sendDurableMessageBatchCore = vi.hoisted(() => vi.fn());

vi.mock("../../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: (...args: unknown[]) => sendDurableMessageBatchCore(...args),
  durableMessageBatchMayHaveReachedRecipient: (result: { status: string }) =>
    result.status === "sent" || result.status === "partial_failed",
}));

import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  createGenericTargetTestPlugin,
  createTargetsTestRegistry,
} from "../../infra/outbound/targets.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { AgentHarnessUserInputQuestion } from "../harness/user-input-types.js";
import { createChannelQuestionPromptDelivery } from "./channel-question-prompt-delivery.js";
import { publishOwnerQuestionPrompt } from "./question-prompt-send.js";

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

describe("publishOwnerQuestionPrompt", () => {
  const registrySnapshot = captureActivePluginRegistrySnapshot();
  const ownerConfig = (publicOrigin?: string): OpenClawConfig => ({
    commands: { ownerAllowFrom: ["alpha:user:owner"] },
    channels: { alpha: {} },
    ...(publicOrigin ? { gateway: { publicOrigin } } : {}),
  });
  const choice: AgentHarnessUserInputQuestion = {
    id: "approval",
    header: "Approval",
    question: "May Bob book Thursday?",
    isOther: true,
    isSecret: false,
    options: [{ label: "Approve" }, { label: "Decline" }],
  };
  const freeText: AgentHarnessUserInputQuestion = {
    id: "reason",
    header: "Reason",
    question: "Why?",
    isOther: true,
    isSecret: false,
    options: null,
  };
  const sentPayload = () => {
    const [request] = sendDurableMessageBatchCore.mock.calls[0] ?? [];
    return (request as { payloads: { text: string; presentation?: unknown }[] }).payloads[0];
  };

  beforeEach(() => {
    sendDurableMessageBatchCore.mockReset();
    sendDurableMessageBatchCore.mockResolvedValue({ status: "sent", results: [], receipt });
    setActivePluginRegistry(
      createTargetsTestRegistry([
        {
          ...createGenericTargetTestPlugin("alpha"),
          agentPrompt: { questionInputMode: "buttons" },
        },
        createGenericTargetTestPlugin("beta"),
      ]),
    );
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    restoreActivePluginRegistrySnapshot(registrySnapshot);
  });

  it("sends the question to the configured owner with its buttons, its answer page and no typed-reply guidance", async () => {
    setRuntimeConfigSnapshot(ownerConfig("https://ops.example.test"));

    await publishOwnerQuestionPrompt({ questionId: "q1", questions: [choice] });

    expect(sendDurableMessageBatchCore).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "alpha",
        to: expect.stringMatching(/user:owner$/),
        durability: "required",
      }),
    );
    const payload = sentPayload();
    expect(payload?.text).toContain(
      "Choose an option, or answer here: https://ops.example.test/ask/q1",
    );
    expect(payload?.text).not.toContain("Reply with");
    expect(JSON.stringify(payload?.presentation)).toContain(
      '"url":"https://ops.example.test/ask/q1"',
    );
    expect(JSON.stringify(payload?.presentation)).not.toContain("custom-input");
  });

  it("links a question without buttons to its answer page", async () => {
    setRuntimeConfigSnapshot(ownerConfig("https://ops.example.test"));

    await publishOwnerQuestionPrompt({ questionId: "q2", questions: [freeText] });

    const payload = sentPayload();
    expect(payload?.presentation).toBeUndefined();
    expect(payload?.text).toContain("Answer here: https://ops.example.test/ask/q2");
  });

  it("rejects a question whose free-text answer has no answer page, so it is cancelled", async () => {
    setRuntimeConfigSnapshot(ownerConfig());

    await expect(
      publishOwnerQuestionPrompt({ questionId: "q3", questions: [choice] }),
    ).rejects.toThrow("gateway.publicOrigin");
    expect(sendDurableMessageBatchCore).not.toHaveBeenCalled();
  });

  it("rejects a question when no owner is configured, so it is cancelled", async () => {
    setRuntimeConfigSnapshot({
      channels: { beta: {} },
      gateway: { publicOrigin: "https://ops.example.test" },
    });

    await expect(
      publishOwnerQuestionPrompt({ questionId: "q4", questions: [choice] }),
    ).rejects.toThrow("commands.ownerAllowFrom");
    expect(sendDurableMessageBatchCore).not.toHaveBeenCalled();
  });

  it("never publishes a question that ended before its prompt was sent", async () => {
    setRuntimeConfigSnapshot(ownerConfig("https://ops.example.test"));

    await publishOwnerQuestionPrompt({
      questionId: "q5",
      questions: [choice],
      isCurrent: async () => false,
    });

    expect(sendDurableMessageBatchCore).not.toHaveBeenCalled();
  });

  it("never sends the question to an owner the config replaced before the send", async () => {
    setRuntimeConfigSnapshot(ownerConfig("https://ops.example.test"));
    const isCurrent = async () => {
      setRuntimeConfigSnapshot({
        ...ownerConfig("https://ops.example.test"),
        commands: { ownerAllowFrom: ["alpha:user:new-owner"] },
      });
      return true;
    };

    await expect(
      publishOwnerQuestionPrompt({ questionId: "q6", questions: [choice], isCurrent }),
    ).rejects.toThrow("owner configuration changed");
    expect(sendDurableMessageBatchCore).not.toHaveBeenCalled();
  });
});

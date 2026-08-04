import { describe, expect, it, vi } from "vitest";
import {
  buildSystemAgentChatResult,
  getSystemAgentChatInputError,
  runSystemAgentChatInput,
} from "./system-agent-chat-turn.js";

function makeEngine() {
  const handle = vi.fn();
  const answerWizard = vi.fn();
  const pollStep = vi.fn();
  return {
    answerWizard,
    handle,
    pollStep,
    engine: { answerWizard, handle, pollStep },
  };
}

describe("system-agent chat input", () => {
  it.each([
    {
      input: {
        sessionId: "s1",
        message: "5",
        wizardAnswer: { stepId: "channel", value: "twitch" },
      },
      error: "Send exactly one of message, wizardAnswer, or pollStepId.",
    },
    {
      input: {
        sessionId: "s1",
        wizardAnswer: { stepId: "secret", value: "not-forwarded" },
        delegation: { agentId: "main", sessionKey: "agent:main:main" },
      },
      error: "Delegated OpenClaw sessions cannot answer or poll structured wizard steps.",
    },
    {
      input: {
        sessionId: "s1",
        wizardAnswer: { stepId: "channel", value: "twitch" },
        reset: true,
      },
      error: "A wizard answer or poll cannot reset its OpenClaw chat session.",
    },
    {
      input: { sessionId: "s1", pollStepId: "qr", message: "continue" },
      error: "Send exactly one of message, wizardAnswer, or pollStepId.",
    },
    {
      input: {
        sessionId: "s1",
        pollStepId: "qr",
        delegation: { agentId: "main", sessionKey: "agent:main:main" },
      },
      error: "Delegated OpenClaw sessions cannot answer or poll structured wizard steps.",
    },
    {
      input: { sessionId: "s1", pollStepId: "qr", reset: true },
      error: "A wizard answer or poll cannot reset its OpenClaw chat session.",
    },
    {
      input: { sessionId: "s1", pollStepId: "qr", welcomeVariant: "onboarding" as const },
      error: "A wizard poll cannot include welcome or UI context.",
    },
    {
      input: { sessionId: "s1", pollStepId: "qr", context: { page: "channels" } },
      error: "A wizard poll cannot include welcome or UI context.",
    },
  ])("rejects invalid mixed input: $error", ({ input, error }) => {
    expect(getSystemAgentChatInputError(input)).toBe(error);
  });

  it("routes a structured wizard answer through the typed engine seam", async () => {
    const { engine, answerWizard, handle } = makeEngine();
    answerWizard.mockResolvedValue({ text: "Next step.", action: "none" });

    await expect(
      runSystemAgentChatInput({
        engine,
        input: {
          sessionId: "s1",
          wizardAnswer: { stepId: "channel", value: "twitch" },
        },
      }),
    ).resolves.toEqual({ text: "Next step.", action: "none" });

    expect(answerWizard).toHaveBeenCalledWith({ stepId: "channel", value: "twitch" });
    expect(handle).not.toHaveBeenCalled();
  });

  it("polls a structured wizard step without answering it", async () => {
    const { engine, pollStep, handle } = makeEngine();
    pollStep.mockResolvedValue({ text: "Still waiting.", action: "none" });

    await expect(
      runSystemAgentChatInput({ engine, input: { sessionId: "s1", pollStepId: "qr" } }),
    ).resolves.toEqual({ text: "Still waiting.", action: "none" });

    expect(pollStep).toHaveBeenCalledWith("qr");
    expect(handle).not.toHaveBeenCalled();
  });

  it("preserves the enriched wizard step in the gateway result", () => {
    expect(
      buildSystemAgentChatResult({
        sessionId: "s1",
        reply: {
          text: "Choose a channel.",
          action: "none",
          step: {
            id: "channel",
            type: "select",
            message: "Channel",
            options: [{ label: "Twitch", value: "twitch" }],
          },
        },
      }),
    ).toMatchObject({
      sessionId: "s1",
      reply: "Choose a channel.",
      action: "none",
      step: { id: "channel", type: "select" },
    });
  });
});

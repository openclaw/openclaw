import { expect, it, vi } from "vitest";
import {
  buildSystemAgentChatResult,
  getSystemAgentChatInputError,
  runSystemAgentChatInput,
} from "./system-agent-chat-turn.js";

const wizardAnswer = { stepId: "channel", value: "twitch" };
const wizardCancel = { stepId: "channel" };
const delegation = { agentId: "main", sessionKey: "agent:main:main" };

it.each([
  [{ message: "5", wizardAnswer }, "Send either message or wizardAnswer, not both."],
  [
    {
      wizardAnswer: { stepId: "secret", value: "not-forwarded" },
      delegation,
    },
    "Delegated OpenClaw sessions cannot submit structured wizard answers.",
  ],
  [{ wizardAnswer, reset: true }, "A wizard answer cannot reset its OpenClaw chat session."],
  [{ message: "cancel", wizardCancel }, "Send wizardCancel without a message or wizardAnswer."],
  [{ wizardAnswer, wizardCancel }, "Send wizardCancel without a message or wizardAnswer."],
  [{ wizardCancel, delegation }, "Delegated OpenClaw sessions cannot cancel hosted wizards."],
  [{ wizardCancel, reset: true }, "A wizard cancel cannot reset its OpenClaw chat session."],
] as const)("rejects invalid mixed input: %j (%s)", (input, error) => {
  expect(getSystemAgentChatInputError({ sessionId: "s1", ...input })).toBe(error);
});

it.each([
  ["wizardAnswer", "answerWizard", wizardAnswer, "Next step."],
  ["wizardCancel", "cancelWizard", wizardCancel, "Setup cancelled."],
] as const)("routes %s through the typed engine seam", async (key, method, value, text) => {
  const engine = { handle: vi.fn(), answerWizard: vi.fn(), cancelWizard: vi.fn() };
  engine[method].mockResolvedValue({ text, action: "none" });
  await expect(
    runSystemAgentChatInput({ engine, input: { sessionId: "s1", [key]: value } }),
  ).resolves.toEqual({ text, action: "none" });
  expect(engine[method]).toHaveBeenCalledWith(value);
  expect(
    engine[method === "answerWizard" ? "cancelWizard" : "answerWizard"],
  ).not.toHaveBeenCalled();
  expect(engine.handle).not.toHaveBeenCalled();
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

it("projects a personal-account handoff without claiming a mutation or changing action", () => {
  expect(
    buildSystemAgentChatResult({
      sessionId: "s1",
      reply: {
        text: "Open your account controls; nothing has changed.",
        action: "none",
        handoff: { kind: "model-accounts" },
      },
    }),
  ).toEqual({
    sessionId: "s1",
    reply: "Open your account controls; nothing has changed.",
    action: "none",
    handoff: { kind: "model-accounts" },
  });
});

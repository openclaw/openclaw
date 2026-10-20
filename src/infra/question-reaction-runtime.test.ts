// Covers portable question-to-reaction rendering and emoji dispatch.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagePresentation, MessagePresentationButton } from "../interactive/payload.js";
import {
  prepareQuestionReactionPayloadForDelivery,
  readQuestionReactionBinding,
  resolveQuestionReactionOverGateway,
} from "./question-reaction-runtime.js";

const hoisted = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../gateway/call.js", () => ({ callGateway: hoisted.callGateway }));

const questionId = "ask_0123456789abcdef0123456789abcdef";
function prepare(labels = ["Staging", "Production"], customInput = false) {
  const buttons: MessagePresentationButton[] = labels.map((label) => ({
    label,
    action: { type: "question", questionId, optionValue: label },
  }));
  if (customInput) {
    buttons.push({
      label: "Other…",
      action: { type: "question", questionId, intent: "custom-input" },
    });
  }
  const presentation: MessagePresentation = {
    blocks: [
      { type: "text", text: "Deploy where?" },
      { type: "buttons", buttons },
    ],
  };
  return prepareQuestionReactionPayloadForDelivery({
    payload: { channelData: { askUser: { questionId } }, presentation },
    presentation,
  });
}

describe("question reaction runtime", () => {
  beforeEach(() => hoisted.callGateway.mockReset());

  it("renders numbered choices and carries a typed delivery binding", () => {
    const payload = prepare();
    expect(payload?.text).toBe("Deploy where?\n\nReact with:\n1️⃣ Staging\n2️⃣ Production");
    expect(payload?.presentation).toBeUndefined();
    expect(readQuestionReactionBinding(payload ?? {})).toEqual({
      questionId,
      optionValues: ["Staging", "Production"],
    });
  });

  it("keeps declared choices when the presentation also offers custom input", () => {
    const payload = prepare(undefined, true);
    expect(readQuestionReactionBinding(payload ?? {})).toEqual({
      questionId,
      optionValues: ["Staging", "Production"],
    });
    expect(payload?.text).toContain("Or reply with your own answer.");
  });

  it("keeps a one-option prompt reaction-eligible", () => {
    const payload = prepare(["Staging"]);
    expect(readQuestionReactionBinding(payload ?? {})).toEqual({
      questionId,
      optionValues: ["Staging"],
    });
  });

  it("resolves a reordered presentation by its rendered option value", async () => {
    const payload = prepare(["Production", "Staging"]);
    const binding = readQuestionReactionBinding(payload ?? {});
    expect(binding?.optionValues).toEqual(["Production", "Staging"]);
    hoisted.callGateway
      .mockResolvedValueOnce({
        question: {
          id: questionId,
          status: "pending",
          questions: [
            {
              questionId: "target",
              header: "Target",
              question: "Deploy where?",
              options: [{ label: "Staging" }, { label: "Production" }],
            },
          ],
          createdAtMs: 1,
          expiresAtMs: 2,
        },
      })
      .mockResolvedValueOnce({ status: "answered" });

    await expect(
      resolveQuestionReactionOverGateway({
        cfg: {} as never,
        questionId,
        optionValue: binding!.optionValues[0]!,
        senderId: "signal:+15550001111",
      }),
    ).resolves.toEqual({
      status: "answered",
      questionId: "target",
      optionValue: "Production",
    });
    expect(hoisted.callGateway.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        method: "question.resolve",
        params: expect.objectContaining({
          answers: { answers: { target: ["Production"] } },
        }),
      }),
    );
  });
});

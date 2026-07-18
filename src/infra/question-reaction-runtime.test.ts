// Covers portable question-to-reaction rendering and emoji dispatch.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareQuestionReactionPayloadForDelivery,
  readQuestionReactionBinding,
  resolveQuestionReactionOverGateway,
} from "./question-reaction-runtime.js";

const hoisted = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../gateway/call.js", () => ({ callGateway: hoisted.callGateway }));

const questionId = "ask_0123456789abcdef0123456789abcdef";
const presentation = {
  blocks: [
    { type: "text" as const, text: "Deploy where?" },
    {
      type: "buttons" as const,
      buttons: ["Staging", "Production"].map((label) => ({
        label,
        action: { type: "question" as const, questionId, optionValue: label },
      })),
    },
  ],
};

describe("question reaction runtime", () => {
  beforeEach(() => hoisted.callGateway.mockReset());

  it("renders numbered choices and carries a typed delivery binding", () => {
    const payload = prepareQuestionReactionPayloadForDelivery({
      payload: { channelData: { askUser: { questionId } }, presentation },
      presentation,
    });
    expect(payload?.text).toBe("Deploy where?\n\nReact with:\n1️⃣ Staging\n2️⃣ Production");
    expect(payload?.presentation).toBeUndefined();
    expect(readQuestionReactionBinding(payload ?? {})).toEqual({ questionId, optionCount: 2 });
  });

  it("keeps a one-option prompt reaction-eligible", () => {
    const singleOptionPresentation = {
      ...presentation,
      blocks: [
        presentation.blocks[0]!,
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "Staging",
              action: { type: "question" as const, questionId, optionValue: "Staging" },
            },
          ],
        },
      ],
    };
    const payload = prepareQuestionReactionPayloadForDelivery({
      payload: {
        channelData: { askUser: { questionId } },
        presentation: singleOptionPresentation,
      },
      presentation: singleOptionPresentation,
    });

    expect(readQuestionReactionBinding(payload ?? {})).toEqual({ questionId, optionCount: 1 });
  });

  it("maps a number emoji through question.get to the canonical label", async () => {
    hoisted.callGateway
      .mockResolvedValueOnce({
        question: {
          id: questionId,
          status: "pending",
          questions: [
            {
              id: "target",
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
        reaction: "2️⃣",
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
          answers: { answers: { target: { answers: ["Production"] } } },
        }),
      }),
    );
  });

  it("ignores unrelated reactions", async () => {
    await expect(
      resolveQuestionReactionOverGateway({
        cfg: {} as never,
        questionId,
        reaction: "👍",
      }),
    ).resolves.toBeNull();
    expect(hoisted.callGateway).not.toHaveBeenCalled();
  });
});

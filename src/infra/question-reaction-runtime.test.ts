import { beforeEach, expect, it, vi } from "vitest";
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

beforeEach(() => hoisted.callGateway.mockReset());

it.each([
  { labels: ["Staging", "Production"], custom: false },
  { labels: ["Staging", "Production"], custom: true },
  { labels: ["Staging"], custom: false },
])("renders reaction choices $labels with custom input=$custom", ({ labels, custom }) => {
  const payload = prepare(labels, custom);
  expect(readQuestionReactionBinding(payload ?? {})).toEqual({
    questionId,
    optionValues: labels,
  });
  if (custom) {
    expect(payload?.text).toContain("Or reply with your own answer.");
  } else if (labels.length === 2) {
    expect(payload).toMatchObject({
      text: "Deploy where?\n\nReact with:\n1️⃣ Staging\n2️⃣ Production",
      presentation: undefined,
    });
  }
});

it("resolves a reordered presentation by its rendered option value", async () => {
  const payload = prepare(["Production", "Staging"]);
  const binding = readQuestionReactionBinding(payload ?? {});
  expect(binding?.optionValues).toEqual(["Production", "Staging"]);
  hoisted.callGateway
    .mockResolvedValueOnce({
      question: {
        status: "pending",
        questions: [
          {
            questionId: "target",
            options: [{ label: "Staging" }, { label: "Production" }],
          },
        ],
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
  expect(hoisted.callGateway.mock.calls[1]?.[0]).toMatchObject({
    method: "question.resolve",
    params: {
      answers: { answers: { target: ["Production"] } },
    },
  });
});

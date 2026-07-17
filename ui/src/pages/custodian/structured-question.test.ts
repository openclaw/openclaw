import { describe, expect, it } from "vitest";
import { parseCustodianReply } from "./structured-question.ts";

const CUSTODIAN_QUESTION_MARKER = "openclaw-user-input";

function markedQuestion(question: unknown): string {
  return `Pick a path.\n<!-- ${CUSTODIAN_QUESTION_MARKER}\n${JSON.stringify(question)}\n-->`;
}

describe("custodian structured question marker", () => {
  it("extracts a valid harness question and preserves visible reply text", () => {
    expect(
      parseCustodianReply(
        markedQuestion({
          id: "access",
          header: "Access",
          question: "How should I work?",
          options: [
            { label: "Full access", description: "Use announced defaults", recommended: true },
            { label: "Ask first" },
          ],
          isOther: false,
        }),
      ),
    ).toEqual({
      text: "Pick a path.",
      question: {
        id: "access",
        header: "Access",
        question: "How should I work?",
        options: [
          { label: "Full access", description: "Use announced defaults", recommended: true },
          { label: "Ask first" },
        ],
        isOther: false,
      },
    });
  });

  it("leaves plain numbered prose and invalid markers untouched", () => {
    const prose = "Choose one:\n1. Full access\n2. Ask first";
    expect(parseCustodianReply(prose)).toEqual({ text: prose, question: null });

    const invalid = markedQuestion({
      id: "too-many",
      header: "Choices",
      question: "Pick one",
      options: ["one", "two"],
    });
    expect(parseCustodianReply(invalid)).toEqual({ text: invalid, question: null });
  });
});

import { expect, it, vi } from "vitest";
import { parseGeneratedAsyncAnswer } from "./chat-async-question-summary.ts";

it("skips title encoding for ordinary messages while parsing quoted generated answers", () => {
  const asyncQuestion = {
    itemId: "question-1",
    questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
  };
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  try {
    expect(
      parseGeneratedAsyncAnswer(asyncQuestion, "Please continue with the same plan."),
    ).toBeNull();
    expect(encode).not.toHaveBeenCalled();
    expect(parseGeneratedAsyncAnswer(asyncQuestion, "> Which audience?\n\nEngineers")).toEqual(
      new Map([["0", { selected: new Set(["Engineers"]), freeText: "" }]]),
    );
  } finally {
    encode.mockRestore();
  }
});

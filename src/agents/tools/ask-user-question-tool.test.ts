/**
 * PR-10: Tests for the ask_user_question tool.
 *
 * Schema validation, duplicate-rejection, and the question_submitted
 * details payload that the runtime intercept reads to emit the
 * approval event.
 */
import { describe, expect, test } from "vitest";
import { createAskUserQuestionTool } from "./ask-user-question-tool.js";
import { ToolInputError } from "./common.js";

const tool = createAskUserQuestionTool();

async function execute(args: Record<string, unknown>) {
  // The execute signature is (toolCallId, args, signal). We only care
  // about the args validation in these tests.
  return tool.execute("call-1", args, new AbortController().signal);
}

type QuestionDetails = {
  status: "question_submitted";
  questionId: string;
  question: string;
  options: string[];
  allowFreetext: boolean;
};
function asQuestionDetails(d: unknown): QuestionDetails {
  return d as QuestionDetails;
}
function firstTextOrThrow(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("expected non-empty content array");
  }
  const first = content[0] as { type?: string; text?: string };
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected first content entry to be {type:'text', text:string}");
  }
  return first.text;
}

describe("ask_user_question schema", () => {
  test("accepts a valid 2-option question", async () => {
    const result = await execute({
      question: "Should I ship as 1 PR or split into 3?",
      options: ["1 PR", "3 PRs"],
    });
    const details = asQuestionDetails(result.details);
    expect(details).toMatchObject({
      status: "question_submitted",
      question: "Should I ship as 1 PR or split into 3?",
      options: ["1 PR", "3 PRs"],
      allowFreetext: false,
    });
    expect(details.questionId).toMatch(/^q-/);
    expect(firstTextOrThrow(result.content)).toContain("Question submitted");
  });

  test("accepts up to 6 options", async () => {
    const result = await execute({
      question: "pick one",
      options: ["a", "b", "c", "d", "e", "f"],
    });
    expect(asQuestionDetails(result.details).options).toHaveLength(6);
  });

  test("accepts allowFreetext=true", async () => {
    const result = await execute({
      question: "pick one",
      options: ["a", "b"],
      allowFreetext: true,
    });
    expect(asQuestionDetails(result.details).allowFreetext).toBe(true);
  });

  test("rejects empty question", async () => {
    await expect(
      execute({
        question: "",
        options: ["a", "b"],
      }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  test("rejects whitespace-only question", async () => {
    await expect(
      execute({
        question: "   ",
        options: ["a", "b"],
      }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  test("rejects when options is missing", async () => {
    await expect(
      execute({
        question: "pick one",
      }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  test("rejects when options has < 2 entries", async () => {
    await expect(
      execute({
        question: "pick one",
        options: ["a"],
      }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  test("rejects when options has > 6 entries", async () => {
    await expect(
      execute({
        question: "pick one",
        options: ["a", "b", "c", "d", "e", "f", "g"],
      }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  test("rejects duplicate option text (would create ambiguous routing)", async () => {
    await expect(
      execute({
        question: "pick one",
        options: ["yes", "yes", "no"],
      }),
    ).rejects.toThrow(/duplicate/);
  });

  test("trims whitespace around option text and the question", async () => {
    const result = await execute({
      question: "  pick one  ",
      options: ["  yes  ", "  no  "],
    });
    expect(asQuestionDetails(result.details)).toMatchObject({
      question: "pick one",
      options: ["yes", "no"],
    });
  });

  test("filters out empty / whitespace-only option entries (rejects if < 2 remain)", async () => {
    await expect(
      execute({
        question: "pick one",
        options: ["yes", "", "  "],
      }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });
});

describe("ask_user_question tool metadata", () => {
  test("declares ask_user_question as the tool name", () => {
    expect(tool.name).toBe("ask_user_question");
  });

  test("returns non-empty content (lossless-claw paired-tool-result fix)", async () => {
    const result = await execute({
      question: "pick one",
      options: ["a", "b"],
    });
    expect(Array.isArray(result.content)).toBe(true);
    const text = firstTextOrThrow(result.content);
    expect(text.length).toBeGreaterThan(0);
  });

  test("derives questionId deterministically from toolCallId (PR-10 H5)", async () => {
    // Same toolCallId → same questionId. Stable IDs keep tool results
    // byte-identical across replays (prompt-cache stability rule).
    const r1 = await execute({ question: "q?", options: ["a", "b"] });
    const r2 = await execute({ question: "q?", options: ["a", "b"] });
    // Both calls used the same hard-coded toolCallId "call-1" via the
    // execute() helper above, so questionIds must match.
    expect(asQuestionDetails(r1.details).questionId).toBe(asQuestionDetails(r2.details).questionId);
    expect(asQuestionDetails(r1.details).questionId).toBe("q-call-1");
  });
});

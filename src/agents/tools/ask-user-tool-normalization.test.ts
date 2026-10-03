import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { AskUserToolSchema, normalizeAskUserParams } from "./ask-user-tool-normalization.js";

const validArgs = {
  questions: [
    {
      id: "deploy_target",
      header: "Deployment target",
      question: "Where should this deploy?",
      options: [
        { label: "Staging (Recommended)", description: "Safer default" },
        { label: "Production" },
      ],
    },
  ],
};

describe("ask_user normalization", () => {
  it("normalizes headers, forces free text, and clamps timeout", () => {
    const normalized = normalizeAskUserParams({ ...validArgs, timeoutSeconds: 5 });

    expect(normalized.timeoutSeconds).toBe(30);
    expect(normalized.questions[0]).toMatchObject({
      questionId: "deploy_target",
      header: "Deployment t",
      isOther: true,
    });
    expect(normalizeAskUserParams({ ...validArgs, timeoutSeconds: 9_999 }).timeoutSeconds).toBe(
      3_600,
    );
    expect(Value.Check(AskUserToolSchema, validArgs)).toBe(true);
    expect(
      Value.Check(AskUserToolSchema, {
        questions: [{ ...validArgs.questions[0], isSecret: true }],
      }),
    ).toBe(false);
    expect(normalized.questions[0]).not.toHaveProperty("isSecret");
  });

  it("drops the custom answer from a prompt moved to another thread", () => {
    const normalized = normalizeAskUserParams({ ...validArgs, threadId: " 1700000000.000200 " });

    expect(normalized.threadId).toBe("1700000000.000200");
    expect(normalized.questions[0]?.isOther).toBe(false);
    expect(JSON.stringify(AskUserToolSchema)).toContain(
      "Typed replies in that thread are not seen",
    );
  });

  it("repeats the structured-choice contract in the model-visible schema", () => {
    const schema = JSON.stringify(AskUserToolSchema);

    expect(schema).toContain("Put all selectable choices in options");
    expect(schema).toContain("Every selectable choice");
    expect(schema).toContain("True only when the user may choose several options at once");
  });

  it.each([
    ["empty questions", { questions: [] }, "model-facing question contract"],
    [
      "too many questions",
      { questions: Array.from({ length: 4 }, () => validArgs.questions[0]) },
      "model-facing question contract",
    ],
    [
      "too few options",
      { questions: [{ ...validArgs.questions[0], options: [{ label: "Only" }] }] },
      "model-facing question contract",
    ],
    [
      "duplicate ids",
      { questions: [validArgs.questions[0], validArgs.questions[0]] },
      "duplicate question id 'deploy_target'",
    ],
    [
      "invalid id",
      { questions: [{ ...validArgs.questions[0], id: "Deploy Target" }] },
      "model-facing question contract",
    ],
    [
      "blank normalized header",
      { questions: [{ ...validArgs.questions[0], header: "   " }] },
      "model-facing display contract",
    ],
    [
      "long normalized option label",
      {
        questions: [
          {
            ...validArgs.questions[0],
            options: [{ label: "x".repeat(65) }, { label: "Production" }],
          },
        ],
      },
      "model-facing display contract",
    ],
    [
      "duplicate normalized option labels",
      {
        questions: [
          {
            ...validArgs.questions[0],
            options: [{ label: "Staging" }, { label: " staging " }],
          },
        ],
      },
      "duplicate option label",
    ],
    ["blank threadId", { ...validArgs, threadId: "   " }, "threadId must be a non-empty string"],
    [
      "several questions with threadId",
      {
        questions: [validArgs.questions[0], { ...validArgs.questions[0], id: "deploy_window" }],
        threadId: "1700000000.000200",
      },
      "threadId supports only one single-select question",
    ],
    [
      "multiSelect with threadId",
      {
        questions: [{ ...validArgs.questions[0], multiSelect: true }],
        threadId: "1700000000.000200",
      },
      "threadId supports only one single-select question",
    ],
  ])("rejects %s", (_name, args, error) => {
    expect(() => normalizeAskUserParams(args)).toThrow(error);
  });
});

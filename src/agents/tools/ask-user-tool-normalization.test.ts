import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { AskUserToolSchema, normalizeAskUserParams } from "./ask-user-tool-normalization.js";
import { createDeploymentQuestion } from "./ask-user-tool.test-support.js";

const question = createDeploymentQuestion("Deployment target");
const validArgs = { questions: [question] };
const withQuestion = (overrides: Partial<typeof question>) => ({
  questions: [{ ...question, ...overrides }],
});

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
      questions: [{ ...question, isSecret: true }],
    }),
  ).toBe(false);
  expect(normalized.questions[0]).not.toHaveProperty("isSecret");
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
    { questions: Array.from({ length: 4 }, () => question) },
    "model-facing question contract",
  ],
  [
    "too few options",
    withQuestion({ options: [{ label: "Only" }] }),
    "model-facing question contract",
  ],
  ["duplicate ids", { questions: [question, question] }, "duplicate question id 'deploy_target'"],
  ["invalid id", withQuestion({ id: "Deploy Target" }), "model-facing question contract"],
  ["blank normalized header", withQuestion({ header: "   " }), "model-facing display contract"],
  [
    "long normalized option label",
    withQuestion({ options: [{ label: "x".repeat(65) }, { label: "Production" }] }),
    "model-facing display contract",
  ],
  [
    "duplicate normalized option labels",
    withQuestion({ options: [{ label: "Staging" }, { label: " staging " }] }),
    "duplicate option label",
  ],
])("rejects %s", (_name, args, error) => {
  expect(() => normalizeAskUserParams(args)).toThrow(error);
});

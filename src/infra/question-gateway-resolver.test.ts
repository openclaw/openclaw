import { beforeEach, expect, it, vi } from "vitest";
import { resolveQuestionOverGateway } from "./question-gateway-resolver.js";

const gateway = vi.hoisted(() => vi.fn());
// mock-isolation: Exercise resolver authorization and outcomes without real Gateway connections.
vi.mock("../gateway/call.js", () => ({ callGateway: gateway }));
const id = "ask_0123456789abcdef0123456789abcdef";
const request = { cfg: {}, questionId: id, optionValue: "Production", senderId: "telegram:42" };
const question = { questionId: "target", options: [{ label: "Production" }] };
const pending = { status: "pending", questions: [question] };
const reply = (record: object = pending) => gateway.mockResolvedValueOnce({ question: record });
const methods = () => gateway.mock.calls.map(([call]) => call.method);
beforeEach(() => gateway.mockReset());

it("does not resolve when access is lost between the read and the write", async () => {
  reply();
  const authorize = vi.fn(() => {
    expect(methods()).toEqual(["question.get"]);
    return false;
  });
  await expect(resolveQuestionOverGateway({ ...request, authorize })).resolves.toEqual({
    status: "denied",
  });
  expect(authorize).toHaveBeenCalledOnce();
  expect(methods()).toEqual(["question.get"]);
});

it("resolves the rendered option with current authorization and sender attribution", async () => {
  reply().mockResolvedValueOnce({ status: "answered" });
  await expect(resolveQuestionOverGateway({ ...request, authorize: () => true })).resolves.toEqual({
    status: "answered",
    questionId: "target",
    optionValue: "Production",
  });
  expect(gateway.mock.calls.map(([call]) => call)).toMatchObject([
    { method: "question.get", params: { id }, scopes: ["operator.questions"] },
    {
      method: "question.resolve",
      params: { id, answers: { answers: { target: ["Production"] } }, resolvedBy: "telegram:42" },
    },
  ]);
});

it.each([
  ["question.get", "QUESTION_NOT_FOUND", "not-found"],
  ["question.resolve", "QUESTION_ALREADY_TERMINAL", "already-terminal"],
] as const)("returns a terminal outcome when %s races", async (method, reason, expectedReason) => {
  if (method === "question.resolve") {
    reply();
  }
  gateway.mockRejectedValueOnce(
    Object.assign(new Error(reason), {
      name: "GatewayClientRequestError",
      details: { reason },
    }),
  );
  await expect(resolveQuestionOverGateway(request)).resolves.toEqual({
    status: "already-terminal",
    reason: expectedReason,
  });
});

it.each([
  [
    "expired",
    { ...pending, status: "expired" },
    { status: "already-terminal", reason: "already-terminal" },
  ],
  [
    "custom",
    { ...pending, questions: [{ ...question, isOther: true }] },
    { status: "custom-input", questionId: "target" },
  ],
] as const)("reads %s input without resolving", async (kind, record, expected) => {
  reply(record);
  await expect(
    resolveQuestionOverGateway(
      kind === "custom" ? { cfg: {}, questionId: id, customInput: true } : request,
    ),
  ).resolves.toEqual(expected);
  expect(methods()).toEqual(["question.get"]);
});

it("leaves option membership validation to question.resolve", async () => {
  reply().mockRejectedValueOnce(new Error("invalid answer"));
  await expect(resolveQuestionOverGateway({ ...request, optionValue: "Other" })).rejects.toThrow(
    "invalid answer",
  );
  expect(methods()).toEqual(["question.get", "question.resolve"]);
});

it("never partially resolves a multi-question record", async () => {
  reply({ ...pending, questions: [question, { ...question, questionId: "region" }] });
  await expect(resolveQuestionOverGateway(request)).rejects.toThrow("one tappable question");
  expect(methods()).toEqual(["question.get"]);
});

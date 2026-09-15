// Covers question-button value resolution through a stubbed Gateway.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelQuestionOverGateway,
  getQuestionOverGateway,
  resolveQuestionAnswersOverGateway,
  resolveQuestionOverGateway,
} from "./question-gateway-resolver.js";

const hoisted = vi.hoisted(() => ({ callGateway: vi.fn() }));

vi.mock("../gateway/call.js", () => ({ callGateway: hoisted.callGateway }));

const recordId = "ask_0123456789abcdef0123456789abcdef";
const pendingRecord = {
  id: recordId,
  status: "pending",
  questions: [
    {
      questionId: "deploy_target",
      header: "Target",
      question: "Where should this deploy?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
  createdAtMs: 1,
  expiresAtMs: 2,
} as const;

function terminalError(reason: "QUESTION_ALREADY_TERMINAL" | "QUESTION_NOT_FOUND") {
  return Object.assign(new Error(reason), {
    name: "GatewayClientRequestError",
    details: { reason },
  });
}

describe("resolveQuestionOverGateway", () => {
  beforeEach(() => {
    hoisted.callGateway.mockReset();
  });

  it("does not resolve when access is lost between the read and the write", async () => {
    hoisted.callGateway.mockResolvedValueOnce({ question: pendingRecord });
    let methodsSeenWhenChecked: string[] = [];

    const result = await resolveQuestionOverGateway({
      cfg: {} as never,
      questionId: recordId,
      optionValue: "Production",
      senderId: "mattermost:42",
      authorize: () => {
        methodsSeenWhenChecked = hoisted.callGateway.mock.calls.map((call) => call[0].method);
        return false;
      },
    });

    expect(result).toEqual({ status: "denied" });
    // The check runs after the read, which is the window it exists to guard.
    expect(methodsSeenWhenChecked).toEqual(["question.get"]);
    // The privileged write never happened.
    expect(hoisted.callGateway.mock.calls.map((call) => call[0].method)).toEqual(["question.get"]);
  });

  it("resolves as usual when access still holds at the write", async () => {
    hoisted.callGateway.mockResolvedValueOnce({ question: pendingRecord }).mockResolvedValueOnce({
      status: "answered",
      answers: { answers: { deploy_target: ["Production"] } },
    });

    await expect(
      resolveQuestionOverGateway({
        cfg: {} as never,
        questionId: recordId,
        optionValue: "Production",
        senderId: "mattermost:42",
        authorize: () => true,
      }),
    ).resolves.toEqual({
      status: "answered",
      questionId: "deploy_target",
      optionValue: "Production",
    });
    expect(hoisted.callGateway.mock.calls.map((call) => call[0].method)).toEqual([
      "question.get",
      "question.resolve",
    ]);
  });

  it("maps the rendered option value to the canonical question id", async () => {
    hoisted.callGateway.mockResolvedValueOnce({ question: pendingRecord }).mockResolvedValueOnce({
      status: "answered",
      answers: { answers: { deploy_target: ["Production"] } },
    });

    await expect(
      resolveQuestionOverGateway({
        cfg: {} as never,
        questionId: recordId,
        optionValue: "Production",
        senderId: "telegram:42",
      }),
    ).resolves.toEqual({
      status: "answered",
      questionId: "deploy_target",
      optionValue: "Production",
    });
    expect(hoisted.callGateway.mock.calls).toEqual([
      [
        expect.objectContaining({
          method: "question.get",
          params: { id: recordId },
          scopes: ["operator.questions"],
        }),
      ],
      [
        expect.objectContaining({
          method: "question.resolve",
          params: {
            id: recordId,
            answers: { answers: { deploy_target: ["Production"] } },
            resolvedBy: "telegram:42",
          },
        }),
      ],
    ]);
  });

  it.each([
    ["question.get", "QUESTION_NOT_FOUND", "not-found"],
    ["question.resolve", "QUESTION_ALREADY_TERMINAL", "already-terminal"],
  ] as const)(
    "returns a terminal outcome when %s races",
    async (method, reason, expectedReason) => {
      if (method === "question.resolve") {
        hoisted.callGateway.mockResolvedValueOnce({ question: pendingRecord });
      }
      hoisted.callGateway.mockRejectedValueOnce(terminalError(reason));

      await expect(
        resolveQuestionOverGateway({
          cfg: {} as never,
          questionId: recordId,
          optionValue: "Staging",
        }),
      ).resolves.toEqual({ status: "already-terminal", reason: expectedReason });
    },
  );

  it("does not resolve an already-terminal record", async () => {
    hoisted.callGateway.mockResolvedValueOnce({
      question: { ...pendingRecord, status: "expired" },
    });

    await expect(
      resolveQuestionOverGateway({
        cfg: {} as never,
        questionId: recordId,
        optionValue: "Staging",
      }),
    ).resolves.toEqual({ status: "already-terminal", reason: "already-terminal" });
    expect(hoisted.callGateway).toHaveBeenCalledOnce();
  });

  it("leaves option membership validation to question.resolve", async () => {
    hoisted.callGateway
      .mockResolvedValueOnce({ question: pendingRecord })
      .mockRejectedValueOnce(new Error("invalid answer"));

    await expect(
      resolveQuestionOverGateway({ cfg: {} as never, questionId: recordId, optionValue: "Other" }),
    ).rejects.toThrow("invalid answer");
    expect(hoisted.callGateway).toHaveBeenCalledTimes(2);
  });

  it("never partially resolves a multi-question record", async () => {
    hoisted.callGateway.mockResolvedValueOnce({
      question: {
        ...pendingRecord,
        questions: [
          ...pendingRecord.questions,
          {
            questionId: "region",
            header: "Region",
            question: "Which region?",
            options: [{ label: "EU" }, { label: "US" }],
          },
        ],
      },
    });

    await expect(
      resolveQuestionOverGateway({
        cfg: {} as never,
        questionId: recordId,
        optionValue: "Staging",
      }),
    ).rejects.toThrow("one tappable question");
    expect(hoisted.callGateway).toHaveBeenCalledOnce();
  });

  it("validates native custom input without resolving the question", async () => {
    hoisted.callGateway.mockResolvedValueOnce({
      question: {
        ...pendingRecord,
        questions: [{ ...pendingRecord.questions[0], isOther: true }],
      },
    });

    await expect(
      resolveQuestionOverGateway({ cfg: {} as never, questionId: recordId, customInput: true }),
    ).resolves.toEqual({ status: "custom-input", questionId: "deploy_target" });
    expect(hoisted.callGateway).toHaveBeenCalledOnce();
  });
});

describe("resolveQuestionAnswersOverGateway", () => {
  const formRecord = {
    ...pendingRecord,
    questions: [
      ...pendingRecord.questions,
      {
        questionId: "regions",
        header: "Regions",
        question: "Which regions?",
        options: [{ label: "EU" }, { label: "US" }],
        multiSelect: true,
        isOther: true,
      },
    ],
  } as const;
  const answers = { deploy_target: ["Staging"], regions: ["EU", "APAC"] };

  beforeEach(() => {
    hoisted.callGateway.mockReset();
  });

  it("submits every answer of a multi-question record in one resolve", async () => {
    hoisted.callGateway.mockResolvedValueOnce({ question: formRecord }).mockResolvedValueOnce({
      status: "answered",
      answers: { answers },
    });

    await expect(
      resolveQuestionAnswersOverGateway({
        cfg: {} as never,
        questionId: recordId,
        answers,
        senderId: "clickclack:usr_1",
        authorize: () => true,
      }),
    ).resolves.toEqual({ status: "answered" });
    expect(hoisted.callGateway.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        method: "question.resolve",
        params: { id: recordId, answers: { answers }, resolvedBy: "clickclack:usr_1" },
        scopes: ["operator.questions"],
      }),
    );
  });

  it("re-checks access after the read and before the write", async () => {
    hoisted.callGateway.mockResolvedValueOnce({ question: formRecord });

    await expect(
      resolveQuestionAnswersOverGateway({
        cfg: {} as never,
        questionId: recordId,
        answers,
        authorize: () => false,
      }),
    ).resolves.toEqual({ status: "denied" });
    expect(hoisted.callGateway.mock.calls.map((call) => call[0].method)).toEqual(["question.get"]);
  });

  it("reports answers the Gateway rejects instead of throwing", async () => {
    hoisted.callGateway.mockResolvedValueOnce({ question: formRecord }).mockRejectedValueOnce(
      Object.assign(new Error("Question deploy_target requires one answer."), {
        name: "GatewayClientRequestError",
        details: { reason: "QUESTION_INVALID_ANSWER" },
      }),
    );

    await expect(
      resolveQuestionAnswersOverGateway({
        cfg: {} as never,
        questionId: recordId,
        answers,
        authorize: () => true,
      }),
    ).resolves.toEqual({
      status: "invalid",
      message: "Question deploy_target requires one answer.",
    });
  });

  it("returns terminal outcomes for finished and missing records", async () => {
    hoisted.callGateway
      .mockResolvedValueOnce({ question: { ...formRecord, status: "expired" } })
      .mockRejectedValueOnce(terminalError("QUESTION_NOT_FOUND"));

    await expect(
      resolveQuestionAnswersOverGateway({
        cfg: {} as never,
        questionId: recordId,
        answers,
        authorize: () => true,
      }),
    ).resolves.toEqual({ status: "already-terminal", reason: "already-terminal" });
    await expect(
      resolveQuestionAnswersOverGateway({
        cfg: {} as never,
        questionId: recordId,
        answers,
        authorize: () => true,
      }),
    ).resolves.toEqual({ status: "already-terminal", reason: "not-found" });
    expect(hoisted.callGateway.mock.calls.map((call) => call[0].method)).toEqual([
      "question.get",
      "question.get",
    ]);
  });

  it("leaves secret questions to their dedicated flow", async () => {
    hoisted.callGateway.mockResolvedValueOnce({
      question: {
        ...pendingRecord,
        questions: [{ ...pendingRecord.questions[0], isSecret: true }],
      },
    });

    await expect(
      resolveQuestionAnswersOverGateway({
        cfg: {} as never,
        questionId: recordId,
        answers: { deploy_target: ["hunter2"] },
        authorize: () => true,
      }),
    ).rejects.toThrow("secret questions");
    expect(hoisted.callGateway).toHaveBeenCalledOnce();
  });
});

describe("getQuestionOverGateway and cancelQuestionOverGateway", () => {
  beforeEach(() => {
    hoisted.callGateway.mockReset();
  });

  it("reads records without their answers and treats dropped records as missing", async () => {
    hoisted.callGateway
      .mockResolvedValueOnce({
        question: {
          ...pendingRecord,
          status: "answered",
          answers: { answers: { deploy_target: ["Production"] } },
          resolvedBy: "clickclack:usr_1",
        },
      })
      .mockRejectedValueOnce(terminalError("QUESTION_NOT_FOUND"));

    await expect(
      getQuestionOverGateway({ cfg: {} as never, questionId: recordId }),
    ).resolves.toEqual({ ...pendingRecord, status: "answered", resolvedBy: "clickclack:usr_1" });
    await expect(
      getQuestionOverGateway({ cfg: {} as never, questionId: recordId }),
    ).resolves.toBeNull();
    await expect(
      getQuestionOverGateway({ cfg: {} as never, questionId: "ask_bad" }),
    ).rejects.toThrow("valid question record id");
  });

  it("cancels a pending question and reports a lost race as terminal", async () => {
    hoisted.callGateway
      .mockResolvedValueOnce({ question: pendingRecord })
      .mockResolvedValueOnce({ status: "cancelled" })
      .mockResolvedValueOnce({ question: pendingRecord })
      .mockRejectedValueOnce(terminalError("QUESTION_ALREADY_TERMINAL"));

    await expect(
      cancelQuestionOverGateway({
        cfg: {} as never,
        questionId: recordId,
        senderId: "clickclack:usr_1",
        authorize: () => true,
      }),
    ).resolves.toEqual({ status: "cancelled" });
    expect(hoisted.callGateway.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        method: "question.resolve",
        params: { id: recordId, cancel: true, resolvedBy: "clickclack:usr_1" },
      }),
    );
    await expect(
      cancelQuestionOverGateway({ cfg: {} as never, questionId: recordId, authorize: () => true }),
    ).resolves.toEqual({ status: "already-terminal", reason: "already-terminal" });
  });

  it("does not cancel when access is lost after the read", async () => {
    hoisted.callGateway.mockResolvedValueOnce({ question: pendingRecord });

    await expect(
      cancelQuestionOverGateway({ cfg: {} as never, questionId: recordId, authorize: () => false }),
    ).resolves.toEqual({ status: "denied" });
    expect(hoisted.callGateway.mock.calls.map((call) => call[0].method)).toEqual(["question.get"]);
  });
});

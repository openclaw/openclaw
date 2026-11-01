import type { Component } from "@earendil-works/pi-tui";
import type {
  QuestionGetResult,
  QuestionListResult,
  QuestionRecord,
  QuestionResolveParams,
  QuestionResolveResult,
} from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOverlayHandle } from "./tui-overlay-handle.test-support.js";
import "./tui-overlay.test-support.js";
import { createTuiQuestionController } from "./tui-questions.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";
const PASTE_ERROR = "Secret paste contains line breaks or unsupported control characters.";

type Question = QuestionRecord["questions"][number];

function question(overrides: Partial<Question> = {}): Question {
  return {
    questionId: "target",
    header: "Target",
    question: "Where should the sample run?",
    options: [
      { label: "Staging", description: "Use the test environment" },
      { label: "Production" },
    ],
    isOther: true,
    ...overrides,
  };
}

function questionRecord(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id: "request-1",
    agentId: "main",
    sessionKey: "agent:main:main",
    createdAtMs: 1_000,
    expiresAtMs: 61_000,
    status: "pending",
    questions: [question()],
    ...overrides,
  };
}

const secretStore = {
  name: "EXAMPLE_KEY",
  kind: "secret",
  allowedHosts: ["api.example.test"],
} satisfies NonNullable<Question["secretStore"]>;

function textQuestion(overrides: Partial<Question> = {}): QuestionRecord {
  return questionRecord({
    questions: [question({ questionId: "value", options: [], ...overrides })],
  });
}

function expectNoLeak(harness: ReturnType<typeof createHarness>, value: string) {
  expect(harness.addSystem.mock.calls.flat().join("\n")).not.toContain(value);
  expect(harness.onPendingChange.mock.calls.flat().join("\n")).not.toContain(value);
}

const answered = {
  status: "answered",
  answers: { answers: { target: ["Staging"] } },
} satisfies QuestionResolveResult;

const controllers: Array<ReturnType<typeof createTuiQuestionController>> = [];

function createHarness(initialRecord?: QuestionRecord) {
  let agentId = "main";
  let sessionKey = "agent:main:main";
  let shown: Component | undefined;
  const addSystem = vi.fn<(line: string) => void>();
  const onPendingChange = vi.fn<(text: string) => void>();
  const openOverlay = vi.fn((component: Component) => {
    shown = component;
    return createOverlayHandle();
  });
  const listQuestions = vi.fn(async (): Promise<QuestionListResult> => ({ questions: [] }));
  const getQuestion = vi.fn<(id: string) => Promise<QuestionGetResult>>(async () => ({
    question: questionRecord(),
  }));
  const resolveQuestion = vi.fn(
    async (params: QuestionResolveParams): Promise<QuestionResolveResult> =>
      "cancel" in params
        ? { status: "cancelled" }
        : { status: "answered", answers: params.answers },
  );
  const controller = createTuiQuestionController({
    client: { listQuestions, getQuestion, resolveQuestion },
    chatLog: { addSystem },
    getAgentId: () => agentId,
    getSessionKey: () => sessionKey,
    openOverlay,
    closeOverlay: () => {
      shown = undefined;
    },
    onPendingChange,
    requestRender: vi.fn(),
  });
  controllers.push(controller);
  const harness = {
    controller,
    addSystem,
    onPendingChange,
    openOverlay,
    listQuestions,
    getQuestion,
    resolveQuestion,
    request(record = questionRecord()) {
      listQuestions.mockResolvedValue({ questions: [record] });
      getQuestion.mockResolvedValue({ question: record });
      controller.handleEvent("question.requested", record);
    },
    resolved(
      status: "answered" | "cancelled" | "expired",
      answers: NonNullable<QuestionRecord["answers"]> = answered.answers,
    ) {
      controller.handleEvent("question.resolved", {
        id: "request-1",
        status,
        ...(status === "answered" ? { answers } : {}),
      });
    },
    selectSession(agent: string, session: string) {
      agentId = agent;
      sessionKey = session;
    },
    input(...keys: string[]) {
      for (const key of keys) {
        if (!shown?.handleInput) {
          throw new Error("question prompt is not open");
        }
        shown.handleInput(key);
      }
    },
    async answer(...keys: string[]) {
      harness.input(...keys, ENTER);
      await settle();
    },
    expectDismissed() {
      expect(harness.render()).toBe("");
      expect(onPendingChange).toHaveBeenLastCalledWith("");
    },
    expectPending(text: string) {
      expect(onPendingChange).toHaveBeenLastCalledWith(expect.stringContaining(text));
    },
    expectOutcome(status: "answered" | "cancelled" | "expired") {
      expect(addSystem).toHaveBeenCalledExactlyOnceWith(
        `Question: ${status === "cancelled" ? "skipped" : status}.`,
      );
    },
    expectSystemOnce(line: string) {
      expect(addSystem.mock.calls.filter(([message]) => message === line)).toHaveLength(1);
    },
    expectAnswers(answers: Record<string, string[]>) {
      expect(resolveQuestion).toHaveBeenCalledWith(
        expect.objectContaining({ answers: { answers } }),
      );
    },
    rawRender(width = 100) {
      return shown?.render(width).join("\n") ?? "";
    },
    render(width = 100) {
      return stripAnsi(shown?.render(width).join("\n") ?? "");
    },
  };
  if (initialRecord) {
    harness.request(initialRecord);
  }
  return harness;
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function startSubmission(record = questionRecord(), ...keys: string[]) {
  const harness = createHarness(record);
  const submission = createDeferred<QuestionResolveResult>();
  harness.resolveQuestion.mockReturnValueOnce(submission.promise);
  harness.input(...keys, ENTER);
  return { harness, submission };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.dispose();
  }
  vi.useRealTimers();
});

describe("TUI questions", () => {
  it.each([DOWN, "2"])("answers using selection keys %j", async (key) => {
    const harness = createHarness(questionRecord());
    expect(harness.render()).toContain("Question 1/1 · Target");
    expect(harness.render()).toContain("Use the test environment");
    await harness.answer(key);
    expect(harness.resolveQuestion).toHaveBeenCalledWith({
      id: "request-1",
      answers: { answers: { target: ["Production"] } },
      resolutionId: expect.any(String),
    });
    expect(harness.render()).toBe("");
    harness.expectOutcome("answered");
  });

  it("advances three questions and submits Other text with the selected answers", async () => {
    const harness = createHarness(
      questionRecord({
        questions: [
          question(),
          question({ questionId: "region", header: "Region" }),
          question({ questionId: "timing", header: "Timing" }),
        ],
      }),
    );
    harness.input("2", ENTER);
    expect(harness.render()).toContain("Question 2/3 · Region");
    harness.input("3", "A custom region", ENTER);
    expect(harness.render()).toContain("Question 3/3 · Timing");
    expect(harness.resolveQuestion).not.toHaveBeenCalled();
    await harness.answer();
    harness.expectAnswers({
      target: ["Production"],
      region: ["A custom region"],
      timing: ["Staging"],
    });
  });

  it("toggles multiple options, combines Other, and waits for explicit confirmation", async () => {
    const harness = createHarness(questionRecord({ questions: [question({ multiSelect: true })] }));
    harness.input("1", "2", " ", " ");
    expect(harness.render()).toContain("[x] 1. Staging");
    expect(harness.render()).toContain("[x] 2. Production");
    expect(harness.resolveQuestion).not.toHaveBeenCalled();
    await harness.answer("3", "Custom", TAB);
    harness.expectAnswers({ target: ["Staging", "Production", "Custom"] });
  });

  it("cancels the whole request with Skip without submitting partial answers", async () => {
    const harness = createHarness(questionRecord());
    await harness.answer(UP);
    expect(harness.resolveQuestion).toHaveBeenCalledExactlyOnceWith({
      id: "request-1",
      cancel: true,
    });
    harness.expectOutcome("cancelled");
  });

  it("masks pasted secrets and shows the secret-store replacement policy", async () => {
    const secret = "synthetic-secret-only";
    const harness = createHarness(
      textQuestion({
        questionId: "credential",
        isSecret: true,
        secretStore: { ...secretStore, reason: "Access the example service" },
        secretStoreExisting: { updatedAtMs: 0 },
      }),
    );
    harness.input(`\x1b[200~${secret}\x1b[201~`);
    expect(harness.render()).toContain("•".repeat(secret.length));
    expect(harness.render()).not.toContain(secret);
    expect(harness.render()).toContain("Secret store entry: EXAMPLE_KEY");
    expect(harness.render()).toContain("Reason: Access the example service");
    expect(harness.render()).toContain("Allowed hosts (accept as proposed): api.example.test");
    expect(harness.render()).toContain("An existing value will be replaced.");
    expect(harness.rawRender(80).split("\n").length).toBeLessThanOrEqual(24);
    await harness.answer();
    harness.expectAnswers({ credential: [secret] });
    expectNoLeak(harness, secret);
  });

  it.each([false, true])(
    "buffers split bracketed paste without treating Enter as submit (secret=%s)",
    async (isSecret) => {
      const harness = createHarness(textQuestion({ isSecret }));
      harness.input("\x1b[200~first", "\r", "second\x1b[201~");
      expect(harness.resolveQuestion).not.toHaveBeenCalled();
      if (isSecret) {
        expect(harness.render()).not.toContain("first");
      }
      await harness.answer();
      if (isSecret) {
        expect(harness.resolveQuestion).not.toHaveBeenCalled();
        expect(harness.render()).toContain(PASTE_ERROR);
      } else {
        expect(harness.resolveQuestion).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("preserves tabs in secret paste and rejects unsupported bytes without submitting a partial value", async () => {
    const harness = createHarness(textQuestion({ isSecret: true }));
    harness.input("\x1b[200~prefix\tsuffix\x1b[201~");
    expect(harness.render()).not.toContain("prefix");
    harness.input("\x1b[200~bad\nvalue\x1b[201~", ENTER);
    expect(harness.resolveQuestion).not.toHaveBeenCalled();
    expect(harness.render()).toContain(PASTE_ERROR);
    expect(harness.render()).not.toContain("bad");
    await harness.answer("\x15", "\x1b[200~prefix\tsuffix\x1b[201~");
    harness.expectAnswers({ value: ["prefix\tsuffix"] });
  });

  it("preserves whitespace-only secret values", async () => {
    const harness = createHarness(textQuestion({ isSecret: true }));
    await harness.answer("   ");
    harness.expectAnswers({ value: ["   "] });
  });

  it("collapses all pending prompts without resolving, preserves the draft, and reopens with /question", async () => {
    const harness = createHarness(questionRecord());
    harness.controller.handleEvent("question.requested", questionRecord({ id: "second" }));
    harness.input("3", "Draft answer", ESC);
    expect(harness.render()).toBe("");
    expect(harness.resolveQuestion).not.toHaveBeenCalled();
    harness.expectPending("/question to open");
    harness.expectPending("Question pending (2)");
    await harness.controller.reopen();
    expect(harness.render()).toContain("Draft answer");
    await harness.answer();
    harness.expectAnswers({ target: ["Draft answer"] });
  });

  it("sanitizes terminal controls and bidirectional overrides in authored text", () => {
    const harness = createHarness(
      textQuestion({
        questionId: "target",
        question: "Question\u001b]52;c;YWJj\u0007\u202e",
        options: [{ label: "Choice\u001b[2J\u2066", description: "Description\u0000" }],
      }),
    );
    const rendered = harness.rawRender();
    expect(rendered).toContain("Question");
    expect(rendered).toContain("Choice");
    for (const control of ["\u001b]52", "\u001b[2J", "\u0000", "\u0007", "\u202e", "\u2066"]) {
      expect(rendered).not.toContain(control);
    }
  });

  it("restores only the active session and agent, including after switching sessions", async () => {
    const harness = createHarness();
    const foreign = questionRecord({
      id: "other",
      agentId: "other",
      sessionKey: "agent:other:main",
    });
    harness.listQuestions.mockResolvedValue({ questions: [foreign, questionRecord()] });
    await harness.controller.refresh();
    expect(harness.render()).toContain("Target");
    harness.selectSession("other", "agent:other:main");
    await harness.controller.sessionChanged();
    await harness.answer();
    expect(harness.resolveQuestion).toHaveBeenCalledWith(expect.objectContaining({ id: "other" }));
  });

  it("rejects malformed records and contradictory session ownership", () => {
    const harness = createHarness();
    harness.controller.handleEvent("question.requested", { id: "malformed" });
    harness.controller.handleEvent("question.requested", questionRecord({ agentId: "other" }));
    expect(harness.openOverlay).not.toHaveBeenCalled();
  });

  it.each(["answered", "cancelled", "expired"] as const)(
    "dismisses questions %s elsewhere without showing answer values",
    (status) => {
      const harness = createHarness(questionRecord());
      harness.resolved(status, { answers: { target: ["synthetic-private-answer"] } });
      harness.expectDismissed();
      expectNoLeak(harness, "synthetic-private-answer");
      expect(harness.resolveQuestion).not.toHaveBeenCalled();
    },
  );

  it("keeps event requests and resolutions newer than an in-flight list snapshot", async () => {
    const harness = createHarness();
    const listing = createDeferred<QuestionListResult>();
    harness.listQuestions.mockReturnValueOnce(listing.promise);
    const refresh = harness.controller.refresh();
    harness.controller.handleEvent("question.requested", questionRecord({ id: "newer" }));
    harness.resolved("cancelled");
    listing.resolve({ questions: [questionRecord()] });
    await refresh;
    await harness.answer();
    expect(harness.resolveQuestion).toHaveBeenCalledWith(expect.objectContaining({ id: "newer" }));
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
  });

  it("deduplicates a resolution event and its RPC response, even with a concurrent refresh", async () => {
    const { harness, submission } = startSubmission();
    await harness.controller.refresh();
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    harness.resolved("answered");
    submission.resolve(answered);
    await settle();
    harness.expectOutcome("answered");
  });

  it("shows a countdown and expires a collapsed question without resolving it", async () => {
    const harness = createHarness(questionRecord({ expiresAtMs: 3_000 }));
    expect(harness.render()).toContain("Expires in 2s");
    harness.input(ESC);
    await vi.advanceTimersByTimeAsync(1_000);
    harness.expectPending("1s");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.onPendingChange).toHaveBeenLastCalledWith("");
    harness.expectOutcome("expired");
    expect(harness.resolveQuestion).not.toHaveBeenCalled();
  });

  it("does not print rejected secret values and leaves the question retryable", async () => {
    const harness = createHarness();
    harness.resolveQuestion.mockRejectedValueOnce(
      new Error("invalid value: synthetic-secret-only"),
    );
    harness.request(textQuestion({ questionId: "key", isSecret: true }));
    await harness.answer("synthetic-secret-only");
    await harness.controller.refresh();
    expect(harness.addSystem).toHaveBeenCalledWith(
      "Question is still pending. Use /question to retry.",
    );
    expectNoLeak(harness, "synthetic-secret-only");
    await harness.controller.reopen();
    expect(harness.render()).toContain("Masked entry");
    expect(harness.render()).not.toContain("•");
  });

  it.each(["answered", "cancelled", "expired"] as const)(
    "recovers a %s result after a lost resolve acknowledgment",
    async (status) => {
      const harness = createHarness(questionRecord());
      harness.resolveQuestion.mockRejectedValueOnce(new Error("connection closed"));
      harness.getQuestion.mockResolvedValue({
        question: questionRecord({ status, ...(status === "answered" ? answered : {}) }),
      });
      await harness.answer();
      expect(harness.getQuestion).toHaveBeenCalledWith("request-1");
      expect(harness.render()).toBe("");
      harness.expectOutcome(status);
    },
  );

  it.each([true, false])(
    "reports saved-secret refresh failures even when the resolved event arrives first (%s)",
    async (eventFirst) => {
      const secret = "synthetic-secret-with-private-suffix";
      const { harness, submission } = startSubmission(
        textQuestion({ questionId: "key", isSecret: true, secretStore }),
        secret,
      );
      if (eventFirst) {
        harness.resolved("answered", { answers: { key: ["stored"] } });
      }
      submission.reject(
        new GatewayClientRequestError({
          code: "UNAVAILABLE",
          message: `Secret store entry was saved, but runtime refresh failed. ${secret}`,
        }),
      );
      await settle();
      expect(harness.addSystem.mock.calls.map(([line]) => line)).toEqual([
        "Question: answered.",
        "Secret stored, but runtime refresh failed. Run openclaw secrets reload; do not resubmit this answer.",
      ]);
      expectNoLeak(harness, secret);
      expect(harness.getQuestion).not.toHaveBeenCalled();
      harness.expectDismissed();
      harness.listQuestions.mockResolvedValue({ questions: [] });
      await harness.controller.reopen();
      expect(harness.render()).toBe("");
      expect(harness.resolveQuestion).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["refresh", "reopen"] as const)(
    "blocks retry while an answer is unconfirmed and reconciles on %s",
    async (action) => {
      const harness = createHarness(questionRecord());
      harness.resolveQuestion.mockRejectedValueOnce(new Error("connection closed"));
      harness.getQuestion.mockRejectedValue(new Error("disconnected"));
      await harness.answer();
      await harness.controller.reopen();
      expect(harness.render()).toBe("");
      expect(harness.resolveQuestion).toHaveBeenCalledTimes(1);
      expect(harness.addSystem).toHaveBeenCalledExactlyOnceWith(
        "Answer confirmation unavailable; use /question to check before retrying.",
      );
      harness.getQuestion.mockResolvedValue({
        question: questionRecord(answered),
      });
      harness.listQuestions.mockResolvedValue({ questions: [] });
      await harness.controller[action]();
      harness.expectSystemOnce("Question: answered.");
      harness.expectDismissed();
    },
  );

  it.each(["not-found", "expiry"] as const)(
    "dismisses unrecoverable confirmation on %s without claiming success or expiry",
    async (reason) => {
      const harness = createHarness(questionRecord({ expiresAtMs: 3_000 }));
      harness.resolveQuestion.mockRejectedValueOnce(new Error("connection closed"));
      harness.getQuestion.mockRejectedValue(
        reason === "not-found"
          ? Object.assign(new Error("question missing"), {
              details: { reason: "QUESTION_NOT_FOUND" },
            })
          : new Error("disconnected"),
      );
      await harness.answer();
      await vi.advanceTimersByTimeAsync(2_000);
      harness.expectDismissed();
      harness.expectSystemOnce(
        "Question outcome could not be recovered; check the conversation or secret store before requesting again.",
      );
      expect(harness.addSystem.mock.calls.flat()).not.toContain("Question: expired.");
      expect(harness.resolveQuestion).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores late list and submission results after disposal", async () => {
    const { harness, submission } = startSubmission();
    const listing = createDeferred<QuestionListResult>();
    harness.listQuestions.mockReturnValueOnce(listing.promise);
    const refresh = harness.controller.refresh();
    harness.controller.dispose();
    listing.resolve({ questions: [questionRecord()] });
    submission.resolve(answered);
    await refresh;
    await settle();
    expect(harness.render()).toBe("");
    expect(harness.addSystem).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

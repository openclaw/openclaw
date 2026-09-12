import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
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
import { createTuiQuestionController } from "./tui-questions.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";

function questionRecord(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id: "request-1",
    agentId: "main",
    sessionKey: "agent:main:main",
    createdAtMs: 1_000,
    expiresAtMs: 61_000,
    status: "pending",
    questions: [
      {
        questionId: "target",
        header: "Target",
        question: "Where should the sample run?",
        options: [
          { label: "Staging", description: "Use the test environment" },
          { label: "Production" },
        ],
        isOther: true,
      },
    ],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const controllers: Array<ReturnType<typeof createTuiQuestionController>> = [];

function createHarness() {
  let agentId = "main";
  let sessionKey = "agent:main:main";
  let shown: Component | undefined;
  const addSystem = vi.fn<(line: string) => void>();
  const onPendingChange = vi.fn<(text: string) => void>();
  const closeOverlay = vi.fn(() => {
    shown = undefined;
  });
  const openOverlay = vi.fn((component: Component) => {
    shown = component;
    return {
      hide() {},
      setHidden() {},
      isHidden: () => false,
      focus() {},
      unfocus() {},
      isFocused: () => true,
    } satisfies OverlayHandle;
  });
  const listQuestions = vi
    .fn<() => Promise<QuestionListResult>>()
    .mockResolvedValue({ questions: [] });
  const getQuestion = vi
    .fn<(id: string) => Promise<QuestionGetResult>>()
    .mockResolvedValue({ question: questionRecord() });
  const resolveQuestion = vi
    .fn<(params: QuestionResolveParams) => Promise<QuestionResolveResult>>()
    .mockImplementation(async (params) =>
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
    closeOverlay,
    onPendingChange,
    requestRender: vi.fn(),
  });
  controllers.push(controller);
  return {
    controller,
    addSystem,
    onPendingChange,
    openOverlay,
    closeOverlay,
    listQuestions,
    getQuestion,
    resolveQuestion,
    request(record = questionRecord()) {
      listQuestions.mockResolvedValue({ questions: [record] });
      getQuestion.mockResolvedValue({ question: record });
      controller.handleEvent("question.requested", record);
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
    rawRender(width = 100) {
      return shown?.render(width).join("\n") ?? "";
    },
    render(width = 100) {
      return stripAnsi(shown?.render(width).join("\n") ?? "");
    },
  };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
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
  it.each([
    [DOWN, ENTER],
    ["2", ENTER],
  ])("answers using selection keys %j", async (...keys) => {
    const harness = createHarness();
    harness.request();
    expect(harness.render()).toContain("Question 1/1 · Target");
    expect(harness.render()).toContain("Use the test environment");
    harness.input(...keys);
    await settle();
    expect(harness.resolveQuestion).toHaveBeenCalledWith({
      id: "request-1",
      answers: { answers: { target: ["Production"] } },
      resolutionId: expect.any(String),
    });
    expect(harness.render()).toBe("");
    expect(harness.addSystem).toHaveBeenCalledExactlyOnceWith("Question: answered.");
  });

  it("advances three questions and submits Other text with the selected answers", async () => {
    const harness = createHarness();
    const first = questionRecord().questions[0]!;
    harness.request(
      questionRecord({
        questions: [
          first,
          { ...first, questionId: "region", header: "Region" },
          { ...first, questionId: "timing", header: "Timing" },
        ],
      }),
    );
    harness.input("2", ENTER);
    expect(harness.render()).toContain("Question 2/3 · Region");
    harness.input("3", "A custom region", ENTER);
    expect(harness.render()).toContain("Question 3/3 · Timing");
    expect(harness.resolveQuestion).not.toHaveBeenCalled();
    harness.input(ENTER);
    await settle();
    expect(harness.resolveQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: {
          answers: { target: ["Production"], region: ["A custom region"], timing: ["Staging"] },
        },
      }),
    );
  });

  it("toggles multiple options, combines Other, and waits for explicit confirmation", async () => {
    const harness = createHarness();
    harness.request(
      questionRecord({ questions: [{ ...questionRecord().questions[0]!, multiSelect: true }] }),
    );
    harness.input("1", "2", " ", " ");
    expect(harness.render()).toContain("[x] 1. Staging");
    expect(harness.render()).toContain("[x] 2. Production");
    expect(harness.resolveQuestion).not.toHaveBeenCalled();
    harness.input("3", "Custom", TAB, ENTER);
    await settle();
    expect(harness.resolveQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: { answers: { target: ["Staging", "Production", "Custom"] } },
      }),
    );
  });

  it("cancels the whole request with Skip without submitting partial answers", async () => {
    const harness = createHarness();
    harness.request();
    harness.input(UP, ENTER);
    await settle();
    expect(harness.resolveQuestion).toHaveBeenCalledExactlyOnceWith({
      id: "request-1",
      cancel: true,
    });
    expect(harness.addSystem).toHaveBeenCalledExactlyOnceWith("Question: skipped.");
  });

  it.each([false, true])(
    "masks secret input, including a pasted value (store-bound=%s)",
    async (storeBound) => {
      const harness = createHarness();
      const secret = "synthetic-secret-only";
      harness.request(
        questionRecord({
          questions: [
            {
              questionId: "credential",
              header: "Credential",
              question: "Enter the synthetic value",
              options: [],
              isSecret: true,
              ...(storeBound
                ? {
                    secretStore: {
                      name: "EXAMPLE_KEY",
                      kind: "secret" as const,
                      reason: "Access the example service",
                      allowedHosts: ["api.example.test"],
                    },
                    secretStoreExisting: { updatedAtMs: 0 },
                  }
                : {}),
            },
          ],
        }),
      );
      harness.input(`\x1b[200~${secret}\x1b[201~`);
      expect(harness.render()).toContain("•".repeat(secret.length));
      expect(harness.render()).not.toContain(secret);
      if (storeBound) {
        expect(harness.render()).toContain("Secret store entry: EXAMPLE_KEY");
        expect(harness.render()).toContain("Reason: Access the example service");
        expect(harness.render()).toContain("Allowed hosts (accept as proposed): api.example.test");
        expect(harness.render()).toContain("An existing value will be replaced.");
        expect(harness.rawRender(80).split("\n").length).toBeLessThanOrEqual(24);
      }
      harness.input(ENTER);
      await settle();
      expect(harness.resolveQuestion).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: { answers: { credential: [secret] } },
        }),
      );
      expect(harness.addSystem.mock.calls.flat().join("\n")).not.toContain(secret);
      expect(harness.onPendingChange.mock.calls.flat().join("\n")).not.toContain(secret);
    },
  );

  it.each([false, true])(
    "buffers split bracketed paste without treating Enter as submit (secret=%s)",
    async (isSecret) => {
      const harness = createHarness();
      harness.request(
        questionRecord({
          questions: [
            {
              questionId: "value",
              header: "Value",
              question: "Enter a value",
              options: [],
              isSecret,
            },
          ],
        }),
      );
      harness.input("\x1b[200~first", "\r", "second\x1b[201~");
      expect(harness.resolveQuestion).not.toHaveBeenCalled();
      if (isSecret) {
        expect(harness.render()).not.toContain("first");
      }
      harness.input(ENTER);
      await settle();
      if (isSecret) {
        expect(harness.resolveQuestion).not.toHaveBeenCalled();
        expect(harness.render()).toContain(
          "Secret paste contains line breaks or unsupported control characters.",
        );
      } else {
        expect(harness.resolveQuestion).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("preserves tabs in secret paste and rejects unsupported bytes without submitting a partial value", async () => {
    const harness = createHarness();
    harness.request(
      questionRecord({
        questions: [
          {
            questionId: "value",
            header: "Value",
            question: "Enter a value",
            options: [],
            isSecret: true,
          },
        ],
      }),
    );
    harness.input("\x1b[200~prefix\tsuffix\x1b[201~");
    expect(harness.render()).not.toContain("prefix");
    harness.input("\x1b[200~bad\nvalue\x1b[201~", ENTER);
    expect(harness.resolveQuestion).not.toHaveBeenCalled();
    expect(harness.render()).toContain(
      "Secret paste contains line breaks or unsupported control characters.",
    );
    expect(harness.render()).not.toContain("bad");
    harness.input("\x15", "\x1b[200~prefix\tsuffix\x1b[201~", ENTER);
    await settle();
    expect(harness.resolveQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { answers: { value: ["prefix\tsuffix"] } } }),
    );
  });

  it("preserves whitespace-only secret values", async () => {
    const harness = createHarness();
    harness.request(
      questionRecord({
        questions: [
          {
            questionId: "value",
            header: "Value",
            question: "Enter a value",
            options: [],
            isSecret: true,
          },
        ],
      }),
    );
    harness.input("   ", ENTER);
    await settle();
    expect(harness.resolveQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { answers: { value: ["   "] } } }),
    );
  });

  it("collapses without resolving, preserves the draft, and reopens with /question", async () => {
    const harness = createHarness();
    harness.request();
    harness.input("3", "Draft answer", ESC);
    expect(harness.render()).toBe("");
    expect(harness.resolveQuestion).not.toHaveBeenCalled();
    expect(harness.onPendingChange).toHaveBeenLastCalledWith(
      expect.stringContaining("/question to open"),
    );
    await harness.controller.reopen();
    expect(harness.render()).toContain("Draft answer");
    harness.input(ENTER);
    await settle();
    expect(harness.resolveQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ answers: { answers: { target: ["Draft answer"] } } }),
    );
  });

  it("returns to the composer on Esc even with multiple pending requests", () => {
    const harness = createHarness();
    harness.request();
    harness.controller.handleEvent("question.requested", questionRecord({ id: "second" }));
    harness.input(ESC);
    expect(harness.render()).toBe("");
    expect(harness.onPendingChange).toHaveBeenLastCalledWith(
      expect.stringContaining("Question pending (2)"),
    );
    expect(harness.resolveQuestion).not.toHaveBeenCalled();
  });

  it("sanitizes terminal controls and bidirectional overrides in authored text", () => {
    const harness = createHarness();
    harness.request(
      questionRecord({
        questions: [
          {
            questionId: "target",
            header: "Target",
            question: "Question\u001b]52;c;YWJj\u0007\u202e",
            options: [{ label: "Choice\u001b[2J\u2066", description: "Description\u0000" }],
          },
        ],
      }),
    );
    const rendered = harness.rawRender();
    expect(rendered).toContain("Question");
    expect(rendered).toContain("Choice");
    expect(rendered).not.toContain("\u001b]52");
    expect(rendered).not.toContain("\u001b[2J");
    expect(rendered).not.toContain("\u0000");
    expect(rendered).not.toContain("\u0007");
    expect(rendered).not.toContain("\u202e");
    expect(rendered).not.toContain("\u2066");
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
    harness.input(ENTER);
    await settle();
    expect(harness.resolveQuestion).toHaveBeenCalledWith(expect.objectContaining({ id: "other" }));
    expect(harness.listQuestions).toHaveBeenCalledTimes(2);
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
      const harness = createHarness();
      harness.request();
      harness.controller.handleEvent("question.resolved", {
        id: "request-1",
        status,
        ...(status === "answered"
          ? { answers: { answers: { target: ["synthetic-private-answer"] } } }
          : {}),
      });
      expect(harness.render()).toBe("");
      expect(harness.onPendingChange).toHaveBeenLastCalledWith("");
      expect(harness.addSystem.mock.calls.flat().join("\n")).not.toContain(
        "synthetic-private-answer",
      );
      expect(harness.resolveQuestion).not.toHaveBeenCalled();
    },
  );

  it("keeps event requests and resolutions newer than an in-flight list snapshot", async () => {
    const harness = createHarness();
    const listing = deferred<QuestionListResult>();
    harness.listQuestions.mockReturnValueOnce(listing.promise);
    const refresh = harness.controller.refresh();
    harness.controller.handleEvent("question.requested", questionRecord({ id: "newer" }));
    harness.controller.handleEvent("question.resolved", { id: "request-1", status: "cancelled" });
    listing.resolve({ questions: [questionRecord()] });
    await refresh;
    harness.input(ENTER);
    await settle();
    expect(harness.resolveQuestion).toHaveBeenCalledWith(expect.objectContaining({ id: "newer" }));
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
  });

  it("deduplicates a resolution event and its RPC response, even with a concurrent refresh", async () => {
    const harness = createHarness();
    const submission = deferred<QuestionResolveResult>();
    harness.resolveQuestion.mockReturnValueOnce(submission.promise);
    harness.request();
    harness.input(ENTER);
    await harness.controller.refresh();
    expect(harness.openOverlay).toHaveBeenCalledTimes(1);
    harness.controller.handleEvent("question.resolved", {
      id: "request-1",
      status: "answered",
      answers: { answers: { target: ["Staging"] } },
    });
    submission.resolve({ status: "answered", answers: { answers: { target: ["Staging"] } } });
    await settle();
    expect(harness.addSystem).toHaveBeenCalledExactlyOnceWith("Question: answered.");
  });

  it("shows a countdown and expires a collapsed question without resolving it", async () => {
    const harness = createHarness();
    harness.request(questionRecord({ expiresAtMs: 3_000 }));
    expect(harness.render()).toContain("Expires in 2s");
    harness.input(ESC);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.onPendingChange).toHaveBeenLastCalledWith(expect.stringContaining("1s"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.onPendingChange).toHaveBeenLastCalledWith("");
    expect(harness.addSystem).toHaveBeenCalledExactlyOnceWith("Question: expired.");
    expect(harness.resolveQuestion).not.toHaveBeenCalled();
  });

  it("does not print rejected secret values and leaves the question retryable", async () => {
    const harness = createHarness();
    harness.resolveQuestion.mockRejectedValueOnce(
      new Error("invalid value: synthetic-secret-only"),
    );
    harness.request(
      questionRecord({
        questions: [
          { questionId: "key", header: "Key", question: "Enter key", options: [], isSecret: true },
        ],
      }),
    );
    harness.input("synthetic-secret-only", ENTER);
    await settle();
    await harness.controller.refresh();
    expect(harness.addSystem).toHaveBeenCalledWith(
      "Question is still pending. Use /question to retry.",
    );
    expect(harness.addSystem.mock.calls.flat().join("\n")).not.toContain("synthetic-secret-only");
    await harness.controller.reopen();
    expect(harness.render()).toContain("Masked entry");
    expect(harness.render()).not.toContain("•");
  });

  it.each(["answered", "cancelled", "expired"] as const)(
    "recovers a %s result after a lost resolve acknowledgment",
    async (status) => {
      const harness = createHarness();
      harness.request();
      harness.resolveQuestion.mockRejectedValueOnce(new Error("connection closed"));
      harness.getQuestion.mockResolvedValue({
        question: questionRecord({
          status,
          ...(status === "answered"
            ? { answers: { answers: { target: ["private answer"] } } }
            : {}),
        }),
      });
      harness.input(ENTER);
      await settle();
      expect(harness.getQuestion).toHaveBeenCalledWith("request-1");
      expect(harness.render()).toBe("");
      expect(harness.addSystem).toHaveBeenCalledExactlyOnceWith(
        `Question: ${status === "cancelled" ? "skipped" : status}.`,
      );
    },
  );

  it.each([true, false])(
    "reports saved-secret refresh failures even when the resolved event arrives first (%s)",
    async (eventFirst) => {
      const harness = createHarness();
      const submission = deferred<QuestionResolveResult>();
      const secret = "synthetic-secret-with-private-suffix";
      harness.request(
        questionRecord({
          questions: [
            {
              questionId: "key",
              header: "Key",
              question: "Enter the example key",
              options: [],
              isSecret: true,
              secretStore: {
                name: "EXAMPLE_KEY",
                kind: "secret",
                allowedHosts: ["api.example.test"],
              },
            },
          ],
        }),
      );
      harness.resolveQuestion.mockReturnValueOnce(submission.promise);
      harness.input(secret, ENTER);
      if (eventFirst) {
        harness.controller.handleEvent("question.resolved", {
          id: "request-1",
          status: "answered",
          answers: { answers: { key: ["stored"] } },
        });
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
      expect(harness.addSystem.mock.calls.flat().join("\n")).not.toContain(secret);
      expect(harness.getQuestion).not.toHaveBeenCalled();
      expect(harness.render()).toBe("");
      expect(harness.onPendingChange).toHaveBeenLastCalledWith("");
      harness.listQuestions.mockResolvedValue({ questions: [] });
      await harness.controller.reopen();
      expect(harness.render()).toBe("");
      expect(harness.resolveQuestion).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["refresh", "reopen"] as const)(
    "blocks retry while an answer is unconfirmed and reconciles on %s",
    async (action) => {
      const harness = createHarness();
      harness.request();
      harness.resolveQuestion.mockRejectedValueOnce(new Error("connection closed"));
      harness.getQuestion.mockRejectedValue(new Error("disconnected"));
      harness.input(ENTER);
      await settle();
      await harness.controller.reopen();
      expect(harness.render()).toBe("");
      expect(harness.resolveQuestion).toHaveBeenCalledTimes(1);
      expect(harness.addSystem).toHaveBeenCalledExactlyOnceWith(
        "Answer confirmation unavailable; use /question to check before retrying.",
      );
      harness.getQuestion.mockResolvedValue({
        question: questionRecord({
          status: "answered",
          answers: { answers: { target: ["Staging"] } },
        }),
      });
      harness.listQuestions.mockResolvedValue({ questions: [] });
      await harness.controller[action]();
      expect(
        harness.addSystem.mock.calls.filter(([line]) => line === "Question: answered."),
      ).toHaveLength(1);
      expect(harness.onPendingChange).toHaveBeenLastCalledWith("");
      expect(harness.render()).toBe("");
    },
  );

  it.each(["not-found", "expiry"] as const)(
    "dismisses unrecoverable confirmation on %s without claiming success or expiry",
    async (reason) => {
      const harness = createHarness();
      harness.request(questionRecord({ expiresAtMs: 3_000 }));
      harness.resolveQuestion.mockRejectedValueOnce(new Error("connection closed"));
      harness.getQuestion.mockRejectedValue(
        reason === "not-found"
          ? Object.assign(new Error("question missing"), {
              details: { reason: "QUESTION_NOT_FOUND" },
            })
          : new Error("disconnected"),
      );
      harness.input(ENTER);
      await settle();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.onPendingChange).toHaveBeenLastCalledWith("");
      expect(harness.render()).toBe("");
      expect(
        harness.addSystem.mock.calls.filter(
          ([line]) =>
            line ===
            "Question outcome could not be recovered; check the conversation or secret store before requesting again.",
        ),
      ).toHaveLength(1);
      expect(harness.addSystem.mock.calls.flat()).not.toContain("Question: expired.");
      expect(harness.resolveQuestion).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores late list and submission results after disposal", async () => {
    const harness = createHarness();
    const submission = deferred<QuestionResolveResult>();
    const listing = deferred<QuestionListResult>();
    harness.resolveQuestion.mockReturnValueOnce(submission.promise);
    harness.request();
    harness.input(ENTER);
    harness.listQuestions.mockReturnValueOnce(listing.promise);
    const refresh = harness.controller.refresh();
    harness.controller.dispose();
    listing.resolve({ questions: [questionRecord()] });
    submission.resolve({ status: "answered", answers: { answers: { target: ["Staging"] } } });
    await refresh;
    await settle();
    expect(harness.render()).toBe("");
    expect(harness.addSystem).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Question,
  QuestionAnswers,
  QuestionResolvedEvent,
} from "../../packages/gateway-protocol/src/index.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  QuestionManager,
  QuestionManagerError,
  QuestionManagerErrorCodes,
  type QuestionObservation,
} from "./question-manager.js";

const QUESTION_RESOLVED_ENTRY_GRACE_MS = 15_000;

type PublicQuestionRequest = Parameters<
  NonNullable<GatewayRequestHandlerOptions["context"]["questionManager"]>["request"]
>[0];

const questions: Question[] = [
  {
    questionId: "choice",
    header: "Choice",
    question: "Which option?",
    options: [
      { label: "One", description: "First" },
      { label: "Two", description: "Second" },
    ],
    isOther: true,
  },
];
const answers = { answers: { choice: ["Two"] } };
const answerResult = { status: "answered", answers };
const receiptResult = (resolutionId: string) => ({ ...answerResult, resolutionId });
const questionList = (overrides: Partial<Question>) => [{ ...questions[0]!, ...overrides }];
const choiceAnswer = (...values: string[]) => ({ answers: { choice: values } });

const invalidAnswerCases: Array<[string, Question[], QuestionAnswers, string]> = [
  [
    "an unanswered prototype-key id",
    questionList({ questionId: "constructor" }),
    { answers: {} },
    "constructor",
  ],
  [
    "an unknown question id",
    questions,
    { answers: { choice: ["Two"], unknown: ["value"] } },
    "unknown",
  ],
  [
    "a missing question answer",
    [...questions, { ...questions[0]!, questionId: "second" }],
    answers,
    "second",
  ],
  ["an empty string", questions, choiceAnswer("  "), "choice"],
  ["an empty secret", questionList({ options: [], isSecret: true }), choiceAnswer(""), "choice"],
  ["multiple single-select values", questions, choiceAnswer("One", "Two"), "choice"],
  ["an undeclared option", questionList({ isOther: false }), choiceAnswer("Three"), "choice"],
];

let manager: QuestionManager;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;

function askQuestion(overrides: Partial<Parameters<QuestionManager["request"]>[0]> = {}) {
  return manager.request({ questions, timeoutMs: 10_000, ...overrides });
}

function sessionAccess(release: () => void) {
  return {
    agentId: "main",
    sessionKey: "agent:main:own",
    canSelect: () => true,
    assertSourceCurrent: () => {},
    assertCurrent: () => {},
    release,
  };
}

function publicationRoot(label: string) {
  resetGatewayWorkAdmission();
  const failure = vi.fn();
  manager = new QuestionManager(scheduler, failure);
  const parent = tryBeginGatewayRootWorkAdmission(label);
  expect(parent).not.toBeNull();
  return { parent, failure, releaseWait: vi.fn(() => parent!.release()) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  clock = createGatewaySchedulerClock(1_000);
  scheduler = createTestGatewayScheduler(clock.clock);
  manager = new QuestionManager(scheduler);
});

afterEach(async () => {
  manager.close();
  await manager.drain();
  await scheduler.stop();
  vi.useRealTimers();
});

describe("QuestionManager", () => {
  it("hides a committing question on reset and settles it without touching a reused id", async () => {
    const commit = createDeferredCore();
    const onResolved = vi.fn();
    const original = askQuestion({ onResolved });
    const waiting = manager.waitAnswer(original.id);
    const pending = manager.resolveWithCommit(original.id, answers, undefined, {
      commit: () => commit.promise,
    });
    let successor: ReturnType<QuestionManager["request"]> | undefined;
    try {
      manager.reset();
      expect(manager.get(original.id)).toBeNull();
      expect(manager.list()).toEqual([]);
      successor = askQuestion({ id: original.id });
    } finally {
      commit.resolve();
      await pending;
    }
    await expect(waiting).resolves.toEqual(answerResult);
    expect(manager.get(original.id)).toBe(successor);
    expect(successor?.status).toBe("pending");
    expect(onResolved).not.toHaveBeenCalled();
  });

  it.each(["cleanup", "reset", "close"] as const)(
    "retains private read facts through completion and releases them on %s",
    async (retirement) => {
      const release = vi.fn();
      const access = sessionAccess(release);
      let requesterActive = true;
      const onResolved = vi.fn();
      const record = askQuestion({
        sessionAccess: access,
        onResolved,
        isRequesterActive: () => requesterActive,
      });
      const observation = manager.observe(record.id)!;
      manager.resolve(record.id, answers);
      requesterActive = false;
      expect(observation.record).toMatchObject(answerResult);
      expect(observation.isCurrent()).toBe(true);
      expect(observation.ordinary).toBe(true);
      expect(observation.sessionAccess).toBe(access);
      expect(onResolved.mock.calls[0]?.[1].sessionAccess).toBe(access);
      expect(release).not.toHaveBeenCalled();
      if (retirement === "cleanup") {
        await manager.drain();
        await clock.advanceBy(15_000);
      }
      if (retirement === "reset") {
        manager.reset();
      }
      if (retirement === "close") {
        manager.close();
      }
      expect(release).toHaveBeenCalledOnce();
      expect(observation.isCurrent()).toBe(false);
      expect(observation.record).toMatchObject(answerResult);
      if (retirement !== "close") {
        askQuestion({ id: record.id });
        expect(observation.isCurrent()).toBe(false);
      }
    },
  );

  it("keeps secret classification immutable and observes without settling expiry", () => {
    const secret = { ...questions[0]!, isSecret: true };
    const onResolved = vi.fn();
    const record = askQuestion({ questions: [secret], timeoutMs: 10, onResolved });
    const observation = manager.observe(record.id)!;
    secret.isSecret = false;
    clock.setTime(2_000);
    expect(manager.observe(record.id)?.record.status).toBe("pending");
    expect(observation.ordinary).toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
    expect(manager.get(record.id)?.status).toBe("expired");
    expect(observation.ordinary).toBe(false);
  });

  it("does not resolve a successor installed synchronously by the original expiry callback", () => {
    const original = askQuestion({
      id: "reused",
      timeoutMs: 10,
      onResolved: () => {
        manager.reset();
        askQuestion({ id: "reused", questions, timeoutMs: 1_000 });
      },
    });
    const observation = manager.observe(original.id)!;
    clock.setTime(1_011);
    expect(() => manager.resolve(original.id, answers)).toThrow("was not found");
    expect(manager.get(original.id)?.status).toBe("pending");
    expect(observation.isCurrent()).toBe(false);
  });

  it("accepts a unique client id and rejects reuse during the grace window", () => {
    const first = askQuestion({ id: "ask_client_id" });

    expect(first.id).toBe("ask_client_id");
    expect(() => askQuestion({ id: "ask_client_id" })).toThrowError(QuestionManagerError);
    try {
      askQuestion({ id: "ask_client_id" });
    } catch (error) {
      expect(error).toMatchObject({ code: QuestionManagerErrorCodes.ID_IN_USE });
    }
  });

  it("keeps resolution receipts opt-in for simultaneous and late waiters", async () => {
    const onResolved = vi.fn();
    const record = askQuestion({ onResolved });
    const legacy = manager.waitAnswer(record.id);
    const tracked = manager.waitAnswer(record.id, undefined, true);
    const resolutionId = "candidate-resolution";

    expect(manager.resolve(record.id, answers, "plain-text", { resolutionId })).toEqual(
      answerResult,
    );
    await expect(legacy).resolves.toEqual(answerResult);
    await expect(tracked).resolves.toEqual(receiptResult(resolutionId));
    await expect(manager.waitAnswer(record.id)).resolves.toEqual(answerResult);
    await expect(manager.waitAnswer(record.id, undefined, true)).resolves.toEqual(
      receiptResult(resolutionId),
    );
    expect(manager.get(record.id)).toMatchObject({ status: "answered", resolvedBy: "plain-text" });
    expect(manager.get(record.id)).not.toHaveProperty("resolutionId");
    expect(onResolved).toHaveBeenCalledOnce();
    expect(onResolved.mock.calls[0]?.[0]).toEqual({ id: record.id, ...answerResult });
    expect(() =>
      manager.resolve(record.id, answers, "other", { resolutionId: "other-resolution" }),
    ).toThrowError(QuestionManagerError);
    await manager.drain();
    await clock.advanceBy(QUESTION_RESOLVED_ENTRY_GRACE_MS);
    expect(manager.get(record.id)).toBeNull();
    // Already-delivered proof survives terminal-record cleanup, without a later lookup.
    await expect(tracked).resolves.toEqual(receiptResult(resolutionId));
  });

  it("does not stamp a receipt when the synchronous commit fails", async () => {
    const record = askQuestion();
    const waiting = manager.waitAnswer(record.id, undefined, true);
    expect(() =>
      manager.resolve(record.id, answers, "failed", {
        resolutionId: "uncommitted",
        commit: () => {
          throw new Error("commit failed");
        },
      }),
    ).toThrow("commit failed");
    expect(manager.get(record.id)?.status).toBe("pending");
    manager.resolve(record.id, answers, "legacy");
    await expect(waiting).resolves.toEqual(answerResult);
  });

  it.each(invalidAnswerCases)(
    "rejects %s without terminalizing",
    (_name, requestQuestions, invalid, questionId) => {
      const record = askQuestion({ questions: [...requestQuestions] });

      expect(() => manager.resolve(record.id, invalid)).toThrow(`question '${questionId}'`);
      expect(manager.get(record.id)?.status).toBe("pending");
    },
  );

  it("accepts trimmed option labels and free text when allowed", () => {
    const strict = askQuestion({
      questions: questionList({ isOther: false }),
    });
    expect(manager.resolve(strict.id, choiceAnswer("  Two  "))).toMatchObject({
      status: "answered",
    });

    const open = askQuestion();
    expect(manager.resolve(open.id, choiceAnswer("custom"))).toMatchObject({
      status: "answered",
    });

    const freeText = askQuestion({
      questions: questionList({ options: [], isOther: false }),
    });
    expect(manager.resolve(freeText.id, choiceAnswer("custom"))).toMatchObject({
      status: "answered",
    });
  });

  it("retires local questions without cancelling truth or refreshing human-input recovery", async () => {
    const onResolved = vi.fn();
    const releaseHumanInputWait = vi.fn();
    const releaseSessionAccess = vi.fn();
    const record = askQuestion({
      onResolved,
      sessionAccess: sessionAccess(releaseSessionAccess),
      registerHumanInputWait: () => releaseHumanInputWait,
    });
    const waiting = manager.waitAnswer(record.id, 5_000);

    manager.reset();
    await expect(waiting).resolves.toEqual({ status: "pending" });
    expect(record.status).toBe("pending");
    expect(manager.get(record.id)).toBeNull();
    expect(releaseHumanInputWait).toHaveBeenCalledExactlyOnceWith(false);
    expect(releaseSessionAccess).toHaveBeenCalledOnce();
    expect(manager.observe(record.id)?.sessionAccess).toBeUndefined();
    await clock.advanceBy(10_000 + QUESTION_RESOLVED_ENTRY_GRACE_MS);
    expect(onResolved).not.toHaveBeenCalled();
    expect(releaseSessionAccess).toHaveBeenCalledOnce();
    expect(askQuestion({ id: record.id }).status).toBe("pending");
  });

  it("permanently closes admission without reset reopening the retired owner", () => {
    const releaseHumanInputWait = vi.fn();
    const releaseSessionAccess = vi.fn();
    const onResolved = vi.fn();
    const record = askQuestion({
      onResolved,
      sessionAccess: sessionAccess(releaseSessionAccess),
      registerHumanInputWait: () => releaseHumanInputWait,
    });
    manager.close();
    manager.reset();
    manager.close();
    expect(() => askQuestion()).toThrow("Question manager is closed");
    expect(manager.get(record.id)).toBeNull();
    expect(releaseHumanInputWait).toHaveBeenCalledExactlyOnceWith(false);
    expect(releaseSessionAccess).toHaveBeenCalledOnce();
    expect(onResolved).not.toHaveBeenCalled();
    expect(clock.armedAtMs).toBeNull();
  });

  it.each(["replacement", "answer"] as const)(
    "keeps a reentrant %s intact when refreshing the original requester",
    (transition) => {
      let armed = false;
      const onResolved = vi.fn();
      const original = askQuestion({
        id: "reentrant-liveness",
        onResolved,
        isRequesterActive: () => {
          if (!armed) {
            return true;
          }
          armed = false;
          if (transition === "replacement") {
            manager.reset();
            askQuestion({ id: "reentrant-liveness" });
          } else {
            manager.resolve("reentrant-liveness", answers);
          }
          return false;
        },
      });
      const observation = manager.observe(original.id)!;
      armed = true;
      observation.refreshRequester();
      if (transition === "replacement") {
        expect(observation.isCurrent()).toBe(false);
        expect(observation.record.status).toBe("pending");
        expect(manager.observe(original.id)?.record).not.toBe(original);
        expect(manager.observe(original.id)?.record.status).toBe("pending");
        expect(onResolved).not.toHaveBeenCalled();
      } else {
        expect(observation.isCurrent()).toBe(true);
        expect(observation.record).toMatchObject(answerResult);
        expect(onResolved).toHaveBeenCalledOnce();
      }
    },
  );

  it("preserves a replacement created by a retired entry's reset callback", async () => {
    const replacementRelease = vi.fn();
    const replacementWaitRelease = vi.fn();
    const release = vi.fn(() => {
      askQuestion({
        id: "reentrant-reset",
        sessionAccess: sessionAccess(replacementRelease),
        registerHumanInputWait: () => replacementWaitRelease,
      });
    });
    const original = askQuestion({
      id: "reentrant-reset",
      registerHumanInputWait: () => release,
    });
    const observation = manager.observe(original.id)!;
    const waiting = manager.waitAnswer(original.id);
    manager.reset();
    await expect(waiting).resolves.toEqual({ status: "pending" });
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
    expect(observation.isCurrent()).toBe(false);
    expect(manager.get(original.id)).toMatchObject({ id: original.id, status: "pending" });
    expect(manager.get(original.id)).not.toBe(original);
    expect(replacementRelease).not.toHaveBeenCalled();
    expect(replacementWaitRelease).not.toHaveBeenCalled();
    expect(clock.armedAtMs).not.toBeNull();
    manager.close();
    expect(replacementRelease).toHaveBeenCalledOnce();
    expect(replacementWaitRelease).toHaveBeenCalledExactlyOnceWith(false);
    expect(clock.armedAtMs).toBeNull();
  });

  it("does not recreate a retention timer when resolution closes the manager reentrantly", () => {
    const record = askQuestion({
      onResolved: () => manager.close(),
    });
    expect(manager.resolve(record.id, answers)).toEqual(answerResult);
    expect(manager.get(record.id)).toBeNull();
    expect(clock.armedAtMs).toBeNull();
  });

  it("preserves an answer recorded before human-input release reentrantly closes its observer", async () => {
    const observer = new AsyncWorkScope();
    const releaseHumanInputWait = vi.fn(() => observer.beginClose());
    const onResolved = vi.fn();
    const record = askQuestion({
      onResolved,
      registerHumanInputWait: () => releaseHumanInputWait,
    });
    const waiting = observer.track(() => manager.waitAnswer(record.id));
    try {
      manager.resolve(record.id, answers);
      await expect(waiting).resolves.toEqual(answerResult);
      expect(manager.get(record.id)).toMatchObject(answerResult);
      expect(releaseHumanInputWait).toHaveBeenCalledExactlyOnceWith(true);
      expect(onResolved).toHaveBeenCalledOnce();
      expect(onResolved.mock.calls[0]?.[0]).toEqual({ id: record.id, ...answerResult });
    } finally {
      manager.close();
      await waiting;
      await observer.drain();
    }
  });

  it("detaches only the closing observer without releasing the question's human-input wait", async () => {
    const observer = new AsyncWorkScope();
    const onResolved = vi.fn();
    const releaseHumanInputWait = vi.fn();
    const record = askQuestion({
      onResolved,
      registerHumanInputWait: () => releaseHumanInputWait,
    });
    let closingObserverSettled = false;
    let otherObserverSettled = false;
    const closingObserver = observer
      .track(() => manager.waitAnswer(record.id, 5_000))
      .then((result) => {
        closingObserverSettled = true;
        return result;
      });
    const otherObserver = manager.waitAnswer(record.id, 5_000).then((result) => {
      otherObserverSettled = true;
      return result;
    });
    try {
      observer.beginClose();
      await vi.advanceTimersByTimeAsync(0);
      expect(closingObserverSettled).toBe(true);
      expect(otherObserverSettled).toBe(false);
      await expect(closingObserver).resolves.toEqual({ status: "pending" });
      await observer.drain();
      expect(manager.get(record.id)?.status).toBe("pending");
      expect(onResolved).not.toHaveBeenCalled();
      expect(releaseHumanInputWait).not.toHaveBeenCalled();

      manager.resolve(record.id, answers);
      await expect(otherObserver).resolves.toEqual(answerResult);
      expect(releaseHumanInputWait).toHaveBeenCalledExactlyOnceWith(true);
      expect(onResolved).toHaveBeenCalledOnce();
      expect(onResolved.mock.calls[0]?.[0]).toEqual({ id: record.id, ...answerResult });
    } finally {
      // Owner retirement is post-observer cleanup, not the cancellation mechanism being tested.
      manager.close();
      await Promise.all([closingObserver, otherObserver]);
      await observer.drain();
    }
  });

  it("times out one waiter without resolving the question", async () => {
    const record = askQuestion();
    const waiting = manager.waitAnswer(record.id, 50);

    await vi.advanceTimersByTimeAsync(50);

    await expect(waiting).resolves.toEqual({ status: "pending" });
    expect(manager.get(record.id)?.status).toBe("pending");
  });

  it("expires once after sleep and joins the terminal publication when the scheduler closes", async () => {
    const publication = createDeferredCore();
    const onResolved = vi.fn(() => publication.promise);
    const record = askQuestion({ questions, timeoutMs: 50, onResolved });
    const waiting = manager.waitAnswer(record.id);
    clock.setTime(70_000);
    const waking = clock.wake();
    expect(await waiting).toEqual({ status: "expired" });
    expect(onResolved).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      publication.resolve();
      await Promise.all([waking, stopping]);
      await clock.advanceBy(60_000);
      expect(onResolved).toHaveBeenCalledOnce();
      expect(manager.get(record.id)?.status).toBe("expired");
      expect(clock.armedAtMs).toBeNull();
    } finally {
      publication.resolve();
      await Promise.all([waking, stopping]);
    }
  });

  it("rejects double resolve and resolve after expiry with typed errors", async () => {
    const answered = askQuestion();
    manager.resolve(answered.id, answers);

    expect(() => manager.resolve(answered.id, answers)).toThrowError(QuestionManagerError);
    try {
      manager.resolve(answered.id, answers);
    } catch (error) {
      expect(error).toMatchObject({ code: QuestionManagerErrorCodes.ALREADY_TERMINAL });
    }

    const expired = askQuestion({ questions, timeoutMs: 10 });
    await clock.advanceBy(10);
    try {
      manager.resolve(expired.id, answers);
      throw new Error("expected resolve to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: QuestionManagerErrorCodes.ALREADY_TERMINAL });
    }
  });

  it("retains authority sweeping for legacy requesters without a run selector", () => {
    let active = true;
    const resolved = vi.fn();
    const record = askQuestion({
      isRequesterActive: () => active,
      onResolved: resolved,
    });
    active = false;
    manager.cancelClosedAuthorities({ instanceId: "other-instance", runId: "other-run" });
    expect(resolved).toHaveBeenCalledWith(
      { id: record.id, status: "cancelled" },
      expect.objectContaining({ record: manager.get(record.id) }),
    );
  });
});

describe("answer canonicalization", () => {
  const valuedOptions = [
    { label: "Blue", value: "blue-1" },
    { label: "Red", value: "red-1" },
  ];
  const duplicateLabels = [
    { label: "Blue", value: "blue-1" },
    { label: "Blue", value: "blue-2" },
  ];
  const valuedAnswerCases: Array<
    [string, Partial<Question>, Question["options"], string, string | undefined]
  > = [
    ["installed form label", { presentation: "form" }, valuedOptions, "Blue", "blue-1"],
    ["form value", { presentation: "form" }, valuedOptions, "blue-1", "blue-1"],
    ["unknown form label", { presentation: "form" }, valuedOptions, "Green", undefined],
    ["inexact form label", { presentation: "form" }, valuedOptions, " Blue ", undefined],
    [
      "value before a conflicting label",
      { presentation: "form" },
      [
        { label: "a", value: "b" },
        { label: "b", value: "c" },
      ],
      "b",
      "b",
    ],
    ["trimmed ordinary label", {}, valuedOptions, "  Blue  ", "blue-1"],
    ["inexact secret label", { isSecret: true }, valuedOptions, " Blue ", undefined],
    [
      "Other form text preserves exact bytes",
      { presentation: "form", isOther: true },
      valuedOptions,
      "\tanything else\n",
      "\tanything else\n",
    ],
    ["ambiguous form label", { presentation: "form" }, duplicateLabels, "Blue", undefined],
    ["first duplicate-label value", { presentation: "form" }, duplicateLabels, "blue-1", "blue-1"],
    ["ambiguous trimmed ordinary label", {}, duplicateLabels, " Blue ", undefined],
  ];
  it.each(valuedAnswerCases)("resolves %s", (_name, overrides, options, submitted, expected) => {
    const record = askQuestion({
      questions: questionList({ options, isOther: false, ...overrides }),
    });
    const resolve = () => manager.resolve(record.id, choiceAnswer(submitted));
    if (expected === undefined) {
      expect(resolve).toThrowError(
        expect.objectContaining({ code: QuestionManagerErrorCodes.INVALID_ANSWER }),
      );
    } else {
      expect(resolve()).toEqual({
        status: "answered",
        answers: choiceAnswer(expected),
      });
    }
  });

  it.each(["\tsynthetic-secret\n", "   "])(
    "preserves exact secret bytes while normalizing ordinary answers: %j",
    async (value) => {
      const record = askQuestion({
        questions: [
          {
            questionId: "secret_value",
            header: "Secret",
            question: "Enter a synthetic secret.",
            options: [],
            isSecret: true,
          },
          ...questions,
        ],
        timeoutMs: 10_000,
      });
      const waiting = manager.waitAnswer(record.id);
      manager.resolve(record.id, { answers: { secret_value: [value], choice: ["  Two  "] } });
      expect(await waiting).toEqual({
        status: "answered",
        answers: { answers: { secret_value: [value], choice: ["Two"] } },
      });
    },
  );
});

it.each(["fulfilled", "rejected"] as const)(
  "joins %s terminal publication on the original root while admission and the owner close",
  async (outcome) => {
    const { parent, failure, releaseWait } = publicationRoot("question-publication");
    const gate = createDeferredCore();
    const entered = vi.fn();
    let id = "";
    await parent!.run(async () => {
      const request = {
        questions,
        timeoutMs: 10_000,
        registerHumanInputWait: () => releaseWait,
        onResolved: async () => {
          entered();
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          await gate.promise;
          if (outcome === "rejected") {
            throw new Error("private fixture failure");
          }
          return { published: true };
        },
      };
      id = askQuestion(request satisfies PublicQuestionRequest).id;
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const waiting = manager.waitAnswer(id);
    manager.resolve(id, answers);
    expect(entered).toHaveBeenCalledOnce();
    expect(releaseWait).toHaveBeenCalledWith(true);
    expect(await waiting).toEqual(answerResult);
    manager.close();
    let drained = false;
    const closing = manager.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    try {
      gate.resolve();
      await closing;
      expect(failure).toHaveBeenCalledTimes(outcome === "rejected" ? 1 : 0);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      gate.resolve();
      await closing;
      parent!.release();
      suspension?.release();
      resetGatewayWorkAdmission();
    }
  },
);

it.each(["fulfilled", "rejected", "reset", "close", "reused id"] as const)(
  "holds terminal grace through %s publication",
  async (outcome) => {
    const { parent, failure, releaseWait } = publicationRoot("question-delayed-publication");
    const gate = createDeferredCore();
    const delivered = vi.fn();
    const releaseSession = vi.fn();
    let id = "";
    await parent!.run(async () => {
      const request = {
        questions,
        timeoutMs: 60_000,
        registerHumanInputWait: () => releaseWait,
        sessionAccess: sessionAccess(releaseSession),
        onResolved: async (event: QuestionResolvedEvent, observation: QuestionObservation) => {
          await gate.promise;
          if (outcome === "rejected") {
            throw new Error("Question publication fixture failure");
          }
          if (observation.isCurrent()) {
            delivered(event);
          }
        },
      };
      id = askQuestion(request satisfies PublicQuestionRequest).id;
    });
    const observation = manager.observe(id)!;
    const waiting = manager.waitAnswer(id);
    expect(manager.resolve(id, answers)).toEqual(answerResult);
    expect(releaseWait).toHaveBeenCalledExactlyOnceWith(true);
    expect(await waiting).toEqual(answerResult);
    try {
      await clock.advanceBy(QUESTION_RESOLVED_ENTRY_GRACE_MS + 1);
      expect(observation.isCurrent()).toBe(true);
      expect(observation.record).toMatchObject(answerResult);
      expect(releaseSession).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(() => askQuestion({ id, questions, timeoutMs: 60_000 })).toThrow("already exists");
      const retired = outcome === "reset" || outcome === "close" || outcome === "reused id";
      if (retired) {
        if (outcome === "close") {
          manager.close();
        } else {
          manager.reset();
        }
        expect(observation.isCurrent()).toBe(false);
        expect(releaseSession).toHaveBeenCalledOnce();
      }
      const replacement =
        outcome === "reused id" ? askQuestion({ id, questions, timeoutMs: 60_000 }) : null;
      gate.resolve();
      await manager.drain();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(failure).toHaveBeenCalledTimes(outcome === "rejected" ? 1 : 0);
      if (outcome === "fulfilled") {
        expect(delivered).toHaveBeenCalledExactlyOnceWith({ id, status: "answered", answers });
      } else {
        expect(delivered).not.toHaveBeenCalled();
      }
      expect(clock.armedAtMs === null).toBe(retired && !replacement);
      await clock.advanceBy(QUESTION_RESOLVED_ENTRY_GRACE_MS - 1);
      if (!retired) {
        expect(observation.isCurrent()).toBe(true);
        expect(releaseSession).not.toHaveBeenCalled();
      }
      await clock.advanceBy(1);
      expect(manager.get(id)).toBe(replacement);
      expect(observation.isCurrent()).toBe(false);
      expect(releaseSession).toHaveBeenCalledOnce();
      expect(clock.armedAtMs === null).toBe(!replacement);
    } finally {
      gate.resolve();
      manager.close();
      await manager.drain();
      parent!.release();
      resetGatewayWorkAdmission();
    }
  },
);

it.each(["answered", "cancelled", "expired"] as const)(
  "settles local %s waiters when reset retired the original publication root",
  async (status) => {
    const { parent, failure, releaseWait } = publicationRoot("question-reset-publication");
    const releaseSession = vi.fn();
    const onResolved = vi.fn();
    let id = "";
    await parent!.run(async () => {
      id = askQuestion({
        timeoutMs: 1_000,
        registerHumanInputWait: () => releaseWait,
        onResolved,
        sessionAccess: sessionAccess(releaseSession),
      }).id;
    });
    const settled = vi.fn();
    const waiting = manager.waitAnswer(id).then(settled);
    try {
      resetGatewayWorkAdmission();
      if (status === "answered") {
        expect(manager.resolve(id, answers)).toEqual({ status, answers });
      } else if (status === "cancelled") {
        expect(manager.cancel(id)).toEqual({ status });
      } else {
        clock.setTime(2_001);
        expect(manager.get(id)?.status).toBe(status);
      }
      await manager.drain();
      expect(settled).toHaveBeenCalledExactlyOnceWith({
        status,
        ...(status === "answered" ? { answers } : {}),
      });
      expect(releaseWait).toHaveBeenCalledExactlyOnceWith(true);
      expect(onResolved).not.toHaveBeenCalled();
      expect(failure).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(manager.get(id)?.status).toBe(status);
      expect(releaseSession).not.toHaveBeenCalled();
      await clock.advanceBy(QUESTION_RESOLVED_ENTRY_GRACE_MS);
      expect(manager.get(id)).toBeNull();
      expect(releaseSession).toHaveBeenCalledOnce();
      expect(clock.armedAtMs).toBeNull();
    } finally {
      manager.close();
      await manager.drain();
      await waiting;
      parent!.release();
      resetGatewayWorkAdmission();
    }
  },
);

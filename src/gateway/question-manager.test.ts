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

const invalidAnswerCases: Array<[string, Question[], QuestionAnswers, string]> = [
  ["an empty answer map", questions, { answers: {} }, "choice"],
  [
    "a prototype-key question id with no submitted answer",
    [{ ...questions[0]!, questionId: "constructor" }],
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
  ["an empty string", questions, { answers: { choice: ["  "] } }, "choice"],
  [
    "an empty secret value",
    [{ ...questions[0]!, options: [], isSecret: true }],
    { answers: { choice: [""] } },
    "choice",
  ],
  [
    "multiple values for a single-select question",
    questions,
    { answers: { choice: ["One", "Two"] } },
    "choice",
  ],
  [
    "a value outside the declared options",
    [{ ...questions[0]!, isOther: false }],
    { answers: { choice: ["Three"] } },
    "choice",
  ],
];

let manager: QuestionManager;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  manager = new QuestionManager();
});

afterEach(() => {
  manager.close();
  vi.useRealTimers();
});

describe("QuestionManager", () => {
  it.each(["cleanup", "reset", "close"] as const)(
    "retains private read facts through completion and releases them on %s",
    async (retirement) => {
      const release = vi.fn();
      const sessionAccess = {
        agentId: "main",
        sessionKey: "agent:main:own",
        canSelect: () => true,
        assertSourceCurrent: () => {},
        assertCurrent: () => {},
        release,
      };
      let requesterActive = true;
      const onResolved = vi.fn();
      const record = manager.request({
        questions,
        timeoutMs: 10_000,
        sessionAccess,
        onResolved,
        isRequesterActive: () => requesterActive,
      });
      const observation = manager.observe(record.id)!;
      manager.resolve(record.id, answers);
      requesterActive = false;
      expect(observation.record).toMatchObject({ status: "answered", answers });
      expect(observation.isCurrent()).toBe(true);
      expect(observation.ordinary).toBe(true);
      expect(observation.sessionAccess).toBe(sessionAccess);
      expect(onResolved.mock.calls[0]?.[1].sessionAccess).toBe(sessionAccess);
      expect(release).not.toHaveBeenCalled();
      if (retirement === "cleanup") {
        await vi.advanceTimersByTimeAsync(15_000);
      }
      if (retirement === "reset") {
        manager.reset();
      }
      if (retirement === "close") {
        manager.close();
      }
      expect(release).toHaveBeenCalledOnce();
      expect(observation.isCurrent()).toBe(false);
      expect(observation.record).toMatchObject({ status: "answered", answers });
      if (retirement !== "close") {
        manager.request({ id: record.id, questions, timeoutMs: 10_000 });
        expect(observation.isCurrent()).toBe(false);
      }
    },
  );

  it("keeps secret classification immutable and observes without settling expiry", () => {
    const secret = { ...questions[0]!, isSecret: true };
    const onResolved = vi.fn();
    const record = manager.request({ questions: [secret], timeoutMs: 10, onResolved });
    const observation = manager.observe(record.id)!;
    secret.isSecret = false;
    vi.setSystemTime(2_000);
    expect(manager.observe(record.id)?.record.status).toBe("pending");
    expect(observation.ordinary).toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
    expect(manager.get(record.id)?.status).toBe("expired");
    expect(observation.ordinary).toBe(false);
  });

  it("does not resolve a successor installed synchronously by the original expiry callback", () => {
    const original = manager.request({
      id: "reused",
      questions,
      timeoutMs: 10,
      onResolved: () => {
        manager.reset();
        manager.request({ id: "reused", questions, timeoutMs: 1_000 });
      },
    });
    const observation = manager.observe(original.id)!;
    vi.setSystemTime(1_011);
    expect(() => manager.resolve(original.id, answers)).toThrow("was not found");
    expect(manager.get(original.id)?.status).toBe("pending");
    expect(observation.isCurrent()).toBe(false);
  });

  it("requests, gets, and deterministically lists pending questions", () => {
    const first = manager.request({
      questions,
      timeoutMs: 10_000,
      agentId: "main",
      runId: "run-first",
    });
    vi.setSystemTime(1_001);
    const second = manager.request({
      questions: [{ ...questions[0]!, questionId: "other" }],
      timeoutMs: 10_000,
      sessionKey: "agent:main:main",
    });

    expect(manager.get(first.id)).toEqual(first);
    expect(first.runId).toBe("run-first");
    expect(manager.list().map((record) => record.id)).toEqual([first.id, second.id]);
  });

  it("accepts a unique client id and rejects reuse during the grace window", () => {
    const first = manager.request({ id: "ask_client_id", questions, timeoutMs: 10_000 });

    expect(first.id).toBe("ask_client_id");
    expect(() =>
      manager.request({ id: "ask_client_id", questions, timeoutMs: 10_000 }),
    ).toThrowError(QuestionManagerError);
    try {
      manager.request({ id: "ask_client_id", questions, timeoutMs: 10_000 });
    } catch (error) {
      expect(error).toMatchObject({ code: QuestionManagerErrorCodes.ID_IN_USE });
    }
  });

  it("accepts ignored synchronous callback results through the public Gateway contract", async () => {
    const observed: QuestionResolvedEvent[] = [];
    const request = {
      questions,
      timeoutMs: 10_000,
      onResolved: (event) => observed.push(event),
    } satisfies PublicQuestionRequest;
    const record = manager.request(request);

    expect(manager.resolve(record.id, answers)).toEqual({ status: "answered", answers });
    expect(observed).toEqual([{ id: record.id, status: "answered", answers }]);
    await manager.drain();
    expect(observed).toHaveLength(1);
  });

  it("keeps resolution receipts opt-in for simultaneous and late waiters", async () => {
    const onResolved = vi.fn();
    const record = manager.request({ questions, timeoutMs: 10_000, onResolved });
    const legacy = manager.waitAnswer(record.id);
    const tracked = manager.waitAnswer(record.id, undefined, true);
    const resolutionId = "candidate-resolution";

    expect(manager.resolve(record.id, answers, "plain-text", { resolutionId })).toEqual({
      status: "answered",
      answers,
    });
    await expect(legacy).resolves.toEqual({ status: "answered", answers });
    await expect(tracked).resolves.toEqual({ status: "answered", answers, resolutionId });
    await expect(manager.waitAnswer(record.id)).resolves.toEqual({ status: "answered", answers });
    await expect(manager.waitAnswer(record.id, undefined, true)).resolves.toEqual({
      status: "answered",
      answers,
      resolutionId,
    });
    expect(manager.get(record.id)).toMatchObject({ status: "answered", resolvedBy: "plain-text" });
    expect(manager.get(record.id)).not.toHaveProperty("resolutionId");
    expect(onResolved).toHaveBeenCalledOnce();
    expect(onResolved.mock.calls[0]?.[0]).toEqual({
      id: record.id,
      status: "answered",
      answers,
    });
    expect(() =>
      manager.resolve(record.id, answers, "other", { resolutionId: "other-resolution" }),
    ).toThrowError(QuestionManagerError);
    await vi.advanceTimersByTimeAsync(QUESTION_RESOLVED_ENTRY_GRACE_MS);
    expect(manager.get(record.id)).toBeNull();
    // Already-delivered proof survives terminal-record cleanup, without a later lookup.
    await expect(tracked).resolves.toEqual({ status: "answered", answers, resolutionId });
  });

  it("does not stamp a receipt when the synchronous commit fails", async () => {
    const record = manager.request({ questions, timeoutMs: 10_000 });
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
    await expect(waiting).resolves.toEqual({ status: "answered", answers });
  });

  it.each(invalidAnswerCases)(
    "rejects %s without terminalizing",
    (_name, requestQuestions, invalid, questionId) => {
      const record = manager.request({ questions: [...requestQuestions], timeoutMs: 10_000 });

      expect(() => manager.resolve(record.id, invalid)).toThrow(`question '${questionId}'`);
      expect(manager.get(record.id)?.status).toBe("pending");
    },
  );

  it("accepts trimmed option labels and free text when allowed", () => {
    const strict = manager.request({
      questions: [{ ...questions[0]!, isOther: false }],
      timeoutMs: 10_000,
    });
    expect(manager.resolve(strict.id, { answers: { choice: ["  Two  "] } })).toMatchObject({
      status: "answered",
    });

    const open = manager.request({ questions, timeoutMs: 10_000 });
    expect(manager.resolve(open.id, { answers: { choice: ["custom"] } })).toMatchObject({
      status: "answered",
    });

    const freeText = manager.request({
      questions: [{ ...questions[0]!, options: [], isOther: false }],
      timeoutMs: 10_000,
    });
    expect(manager.resolve(freeText.id, { answers: { choice: ["custom"] } })).toMatchObject({
      status: "answered",
    });
  });

  it("retires local questions without cancelling truth or refreshing human-input recovery", async () => {
    const onResolved = vi.fn();
    const releaseHumanInputWait = vi.fn();
    const releaseSessionAccess = vi.fn();
    const record = manager.request({
      questions,
      timeoutMs: 10_000,
      onResolved,
      sessionAccess: {
        agentId: "main",
        sessionKey: "agent:main:own",
        canSelect: () => true,
        assertSourceCurrent: () => {},
        assertCurrent: () => {},
        release: releaseSessionAccess,
      },
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
    await vi.advanceTimersByTimeAsync(10_000 + QUESTION_RESOLVED_ENTRY_GRACE_MS);
    expect(onResolved).not.toHaveBeenCalled();
    expect(releaseSessionAccess).toHaveBeenCalledOnce();
    expect(manager.request({ id: record.id, questions, timeoutMs: 10_000 }).status).toBe("pending");
  });

  it("permanently closes admission without reset reopening the retired owner", () => {
    const releaseHumanInputWait = vi.fn();
    const releaseSessionAccess = vi.fn();
    const onResolved = vi.fn();
    const record = manager.request({
      questions,
      timeoutMs: 10_000,
      onResolved,
      sessionAccess: {
        agentId: "main",
        sessionKey: "agent:main:own",
        canSelect: () => true,
        assertSourceCurrent: () => {},
        assertCurrent: () => {},
        release: releaseSessionAccess,
      },
      registerHumanInputWait: () => releaseHumanInputWait,
    });
    manager.close();
    manager.reset();
    manager.close();
    expect(() => manager.request({ questions, timeoutMs: 10_000 })).toThrow(
      "Question manager is closed",
    );
    expect(manager.get(record.id)).toBeNull();
    expect(releaseHumanInputWait).toHaveBeenCalledExactlyOnceWith(false);
    expect(releaseSessionAccess).toHaveBeenCalledOnce();
    expect(onResolved).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["replacement", "answer"] as const)(
    "keeps a reentrant %s intact when refreshing the original requester",
    (transition) => {
      let armed = false;
      const onResolved = vi.fn();
      const original = manager.request({
        id: "reentrant-liveness",
        questions,
        timeoutMs: 10_000,
        onResolved,
        isRequesterActive: () => {
          if (!armed) {
            return true;
          }
          armed = false;
          if (transition === "replacement") {
            manager.reset();
            manager.request({ id: "reentrant-liveness", questions, timeoutMs: 10_000 });
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
        expect(observation.record).toMatchObject({ status: "answered", answers });
        expect(onResolved).toHaveBeenCalledOnce();
      }
    },
  );

  it("preserves a replacement created by a retired entry's reset callback", async () => {
    const replacementRelease = vi.fn();
    const replacementWaitRelease = vi.fn();
    const release = vi.fn(() => {
      manager.request({
        id: "reentrant-reset",
        questions,
        timeoutMs: 10_000,
        sessionAccess: {
          agentId: "main",
          sessionKey: "agent:main:own",
          canSelect: () => true,
          assertSourceCurrent: () => {},
          assertCurrent: () => {},
          release: replacementRelease,
        },
        registerHumanInputWait: () => replacementWaitRelease,
      });
    });
    const original = manager.request({
      id: "reentrant-reset",
      questions,
      timeoutMs: 10_000,
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
    expect(vi.getTimerCount()).toBe(1);
    manager.close();
    expect(replacementRelease).toHaveBeenCalledOnce();
    expect(replacementWaitRelease).toHaveBeenCalledExactlyOnceWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not recreate a retention timer when resolution closes the manager reentrantly", () => {
    const record = manager.request({
      questions,
      timeoutMs: 10_000,
      onResolved: () => manager.close(),
    });
    expect(manager.resolve(record.id, answers)).toEqual({ status: "answered", answers });
    expect(manager.get(record.id)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an answer recorded before human-input release reentrantly closes its observer", async () => {
    const observer = new AsyncWorkScope();
    const releaseHumanInputWait = vi.fn(() => observer.beginClose());
    const onResolved = vi.fn();
    const record = manager.request({
      questions,
      timeoutMs: 10_000,
      onResolved,
      registerHumanInputWait: () => releaseHumanInputWait,
    });
    const waiting = observer.track(() => manager.waitAnswer(record.id));
    try {
      manager.resolve(record.id, answers);
      await expect(waiting).resolves.toEqual({ status: "answered", answers });
      expect(manager.get(record.id)).toMatchObject({ status: "answered", answers });
      expect(releaseHumanInputWait).toHaveBeenCalledExactlyOnceWith(true);
      expect(onResolved).toHaveBeenCalledOnce();
      expect(onResolved.mock.calls[0]?.[0]).toEqual({
        id: record.id,
        status: "answered",
        answers,
      });
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
    const record = manager.request({
      questions,
      timeoutMs: 10_000,
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
      await expect(otherObserver).resolves.toEqual({ status: "answered", answers });
      expect(releaseHumanInputWait).toHaveBeenCalledExactlyOnceWith(true);
      expect(onResolved).toHaveBeenCalledOnce();
      expect(onResolved.mock.calls[0]?.[0]).toEqual({
        id: record.id,
        status: "answered",
        answers,
      });
    } finally {
      // Owner retirement is post-observer cleanup, not the cancellation mechanism being tested.
      manager.close();
      await Promise.all([closingObserver, otherObserver]);
      await observer.drain();
    }
  });

  it("times out one waiter without resolving the question", async () => {
    const record = manager.request({ questions, timeoutMs: 10_000 });
    const waiting = manager.waitAnswer(record.id, 50);

    await vi.advanceTimersByTimeAsync(50);

    await expect(waiting).resolves.toEqual({ status: "pending" });
    expect(manager.get(record.id)?.status).toBe("pending");
  });

  it("expires pending questions and emits the terminal event", async () => {
    const onResolved = vi.fn();
    const record = manager.request({ questions, timeoutMs: 50, onResolved });
    const waiting = manager.waitAnswer(record.id);

    await vi.advanceTimersByTimeAsync(50);

    await expect(waiting).resolves.toEqual({ status: "expired" });
    expect(manager.get(record.id)?.status).toBe("expired");
    expect(onResolved.mock.calls[0]?.[0]).toEqual({ id: record.id, status: "expired" });
  });

  it("cancels pending questions", async () => {
    const record = manager.request({ questions, timeoutMs: 10_000 });
    const waiting = manager.waitAnswer(record.id);

    expect(manager.cancel(record.id, "agent")).toEqual({ status: "cancelled" });
    await expect(waiting).resolves.toEqual({ status: "cancelled" });
    expect(manager.get(record.id)).toMatchObject({ status: "cancelled", resolvedBy: "agent" });
  });

  it("rejects double resolve and resolve after expiry with typed errors", async () => {
    const answered = manager.request({ questions, timeoutMs: 10_000 });
    manager.resolve(answered.id, answers);

    expect(() => manager.resolve(answered.id, answers)).toThrowError(QuestionManagerError);
    try {
      manager.resolve(answered.id, answers);
    } catch (error) {
      expect(error).toMatchObject({ code: QuestionManagerErrorCodes.ALREADY_TERMINAL });
    }

    const expired = manager.request({ questions, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    try {
      manager.resolve(expired.id, answers);
      throw new Error("expected resolve to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: QuestionManagerErrorCodes.ALREADY_TERMINAL });
    }
  });

  it("keeps terminal records through the grace window", async () => {
    let accessActive = true;
    const releaseSessionAccess = vi.fn(() => {
      accessActive = false;
    });
    const record = manager.request({
      questions,
      timeoutMs: 10_000,
      sessionAccess: {
        agentId: "main",
        sessionKey: "agent:main:own",
        canSelect: () => accessActive,
        assertSourceCurrent: () => {},
        assertCurrent: () => {},
        release: releaseSessionAccess,
      },
    });
    manager.resolve(record.id, answers);

    await vi.advanceTimersByTimeAsync(QUESTION_RESOLVED_ENTRY_GRACE_MS - 1);
    expect(manager.get(record.id)?.status).toBe("answered");
    expect(manager.observe(record.id)?.sessionAccess?.canSelect(null)).toBe(true);
    expect(releaseSessionAccess).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(manager.get(record.id)).toBeNull();
    expect(manager.observe(record.id)?.sessionAccess).toBeUndefined();
    expect(releaseSessionAccess).toHaveBeenCalledOnce();
    manager.close();
    expect(releaseSessionAccess).toHaveBeenCalledOnce();
  });

  it("retains authority sweeping for legacy requesters without a run selector", () => {
    let active = true;
    const resolved = vi.fn();
    const record = manager.request({
      questions,
      timeoutMs: 10_000,
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
  it.each(["\tsynthetic-secret\n", "   "])(
    "preserves exact secret bytes while normalizing ordinary answers: %j",
    async (value) => {
      const record = manager.request({
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

  it("stores declared option labels for trim-variant submissions", () => {
    const localManager = new QuestionManager();
    const record = localManager.request({
      questions: [
        {
          questionId: "pick",
          header: "Pick",
          question: "Pick one",
          options: [{ label: "Two" }, { label: "Three" }],
          isOther: false,
        },
      ],
      timeoutMs: 60_000,
    });
    const result = localManager.resolve(record.id, {
      answers: { pick: ["  Two  "] },
    });
    expect(result).toEqual({
      status: "answered",
      answers: { answers: { pick: ["Two"] } },
    });
    localManager.close();
  });
});

it.each(["fulfilled", "rejected"] as const)(
  "joins %s terminal publication on the original root while admission and the owner close",
  async (outcome) => {
    resetGatewayWorkAdmission();
    const failure = vi.fn();
    manager = new QuestionManager(failure);
    const parent = tryBeginGatewayRootWorkAdmission("question-publication");
    expect(parent).not.toBeNull();
    const gate = createDeferredCore();
    const entered = vi.fn();
    const releaseWait = vi.fn(() => parent!.release());
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
      id = manager.request(request satisfies PublicQuestionRequest).id;
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const waiting = manager.waitAnswer(id);
    manager.resolve(id, answers);
    expect(entered).toHaveBeenCalledOnce();
    expect(releaseWait).toHaveBeenCalledWith(true);
    expect(await waiting).toEqual({ status: "answered", answers });
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
    resetGatewayWorkAdmission();
    const failure = vi.fn();
    manager = new QuestionManager(failure);
    const parent = tryBeginGatewayRootWorkAdmission("question-delayed-publication");
    expect(parent).not.toBeNull();
    const gate = createDeferredCore();
    const delivered = vi.fn();
    const releaseSession = vi.fn();
    const releaseWait = vi.fn(() => parent!.release());
    let id = "";
    await parent!.run(async () => {
      const request = {
        questions,
        timeoutMs: 60_000,
        registerHumanInputWait: () => releaseWait,
        sessionAccess: {
          agentId: "main",
          sessionKey: "agent:main:own",
          canSelect: () => true,
          assertSourceCurrent: () => {},
          assertCurrent: () => {},
          release: releaseSession,
        },
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
      id = manager.request(request satisfies PublicQuestionRequest).id;
    });
    const observation = manager.observe(id)!;
    const waiting = manager.waitAnswer(id);
    expect(manager.resolve(id, answers)).toEqual({ status: "answered", answers });
    expect(releaseWait).toHaveBeenCalledExactlyOnceWith(true);
    expect(await waiting).toEqual({ status: "answered", answers });
    try {
      await vi.advanceTimersByTimeAsync(QUESTION_RESOLVED_ENTRY_GRACE_MS + 1);
      expect(observation.isCurrent()).toBe(true);
      expect(observation.record).toMatchObject({ status: "answered", answers });
      expect(releaseSession).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(() => manager.request({ id, questions, timeoutMs: 60_000 })).toThrow("already exists");
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
        outcome === "reused id" ? manager.request({ id, questions, timeoutMs: 60_000 }) : null;
      gate.resolve();
      await manager.drain();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(failure).toHaveBeenCalledTimes(outcome === "rejected" ? 1 : 0);
      if (outcome === "fulfilled") {
        expect(delivered).toHaveBeenCalledExactlyOnceWith({ id, status: "answered", answers });
      } else {
        expect(delivered).not.toHaveBeenCalled();
      }
      expect(vi.getTimerCount()).toBe(retired && !replacement ? 0 : 1);
      await vi.advanceTimersByTimeAsync(QUESTION_RESOLVED_ENTRY_GRACE_MS - 1);
      if (!retired) {
        expect(observation.isCurrent()).toBe(true);
        expect(releaseSession).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.get(id)).toBe(replacement);
      expect(observation.isCurrent()).toBe(false);
      expect(releaseSession).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(replacement ? 1 : 0);
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
    resetGatewayWorkAdmission();
    const failure = vi.fn();
    manager = new QuestionManager(failure);
    const parent = tryBeginGatewayRootWorkAdmission("question-reset-publication");
    expect(parent).not.toBeNull();
    const releaseWait = vi.fn(() => parent!.release());
    const releaseSession = vi.fn();
    const onResolved = vi.fn();
    let id = "";
    await parent!.run(async () => {
      id = manager.request({
        questions,
        timeoutMs: 1_000,
        registerHumanInputWait: () => releaseWait,
        onResolved,
        sessionAccess: {
          agentId: "main",
          sessionKey: "agent:main:own",
          canSelect: () => true,
          assertSourceCurrent: () => {},
          assertCurrent: () => {},
          release: releaseSession,
        },
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
        vi.setSystemTime(2_001);
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
      await vi.advanceTimersByTimeAsync(QUESTION_RESOLVED_ENTRY_GRACE_MS);
      expect(manager.get(id)).toBeNull();
      expect(releaseSession).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      manager.close();
      await manager.drain();
      await waiting;
      parent!.release();
      resetGatewayWorkAdmission();
    }
  },
);

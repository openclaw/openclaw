import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { DurableQuestion } from "../config/sessions/session-questions.types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createQuestionContinuationWork } from "./question-continuation-work.js";

function question(identity = "original"): DurableQuestion {
  return {
    record: {
      id: "reused-question",
      agentId: "main",
      sessionKey: "agent:main:test",
      status: "answered",
      createdAtMs: 1,
      expiresAtMs: 60_001,
      questions: [],
      answers: { answers: {} },
    },
    sessionKey: "agent:main:test",
    sessionId: "session",
    lifecycleRevision: "revision",
    sessionBinding: {
      agentId: "main",
      sessionKey: "agent:main:test",
      storePath: "/fixture/sessions.db",
      databasePath: "/fixture/sessions.db",
      databaseIdentity: { identity },
      sessionId: "session",
      lifecycleRevision: "revision",
    },
    provenance: { issuer: "operator", sourceRunId: "asking" },
    resolutionId: "answer",
    continuation: { status: "owed" },
  };
}

it("admits same-ID successor custody while old publication is held and joins both tails", async () => {
  const scope = new AsyncWorkScope();
  let closing = false;
  const work = createQuestionContinuationWork({
    scheduler: createTestGatewayScheduler(),
    track: (run) => scope.track(run),
    isClosing: () => closing,
  });
  const oldPublication = createDeferredCore();
  const successorExecution = createDeferredCore();
  const old = question();
  const successor = question("replacement");
  const dispatch = vi.fn(async (captured: DurableQuestion) => {
    if (captured === successor) {
      await successorExecution.promise;
    }
  });
  const oldRun = work.offer(old, async () => {
    await dispatch(old);
    await oldPublication.promise;
  });
  // The old dispatch already completed; publication alone retains its custody work.
  await Promise.resolve();
  const successorRun = work.offer(successor, () => dispatch(successor));
  expect(
    dispatch.mock.calls.map(([captured]) => captured.sessionBinding.databaseIdentity.identity),
  ).toEqual(["original", "replacement"]);
  expect(work.offer(structuredClone(successor), () => dispatch(successor))).toBeUndefined();
  oldPublication.resolve();
  await expectDefined(oldRun, "original work");
  // Cleanup for the old public ID cannot remove its still-running physical successor.
  expect(work.offer(structuredClone(successor), () => dispatch(successor))).toBeUndefined();
  closing = true;
  let joined = false;
  const stop = scope.drain().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  expect(work.offer(question("third"), () => dispatch(successor))).toBeUndefined();
  successorExecution.resolve();
  await expectDefined(successorRun, "successor work");
  await stop;
  expect(joined).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it("deduplicates canonical optional-field normalization but preserves exact deadlines and resolution", async () => {
  const scope = new AsyncWorkScope();
  const work = createQuestionContinuationWork({
    scheduler: createTestGatewayScheduler(),
    track: (run) => scope.track(run),
    isClosing: () => false,
  });
  const gate = createDeferredCore();
  const run = vi.fn(() => gate.promise);
  const original = question();
  const first = work.offer(original, run);
  const normalized = structuredClone(original);
  normalized.sessionBinding.profileId = undefined;
  expect(work.offer(normalized, run)).toBeUndefined();
  const renewed = structuredClone(original);
  renewed.record.createdAtMs += 1;
  renewed.record.expiresAtMs += 1;
  const second = work.offer(renewed, run);
  const otherResolution = structuredClone(original);
  otherResolution.resolutionId = "other-answer";
  const third = work.offer(otherResolution, run);
  expect(run).toHaveBeenCalledTimes(3);
  gate.resolve();
  await Promise.all([
    expectDefined(first, "original work"),
    expectDefined(second, "renewed work"),
    expectDefined(third, "other resolution"),
  ]);
  await scope.drain();
});

it("joins a running retry on close and retains exact dedupe through its publication tail", async () => {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const tracked = new AsyncWorkScope();
  const work = createQuestionContinuationWork({
    scheduler,
    track: (run) => tracked.track(run),
    isClosing: () => false,
  });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let calls = 0;
  const run = async () => {
    if (++calls === 1) {
      return { status: "admission_owed" } as const;
    }
    entered.resolve();
    await release.promise;
    return undefined;
  };
  const saved = question();
  await work.offer(saved, run);
  const wake = clock.advanceBy(1_000);
  await entered.promise;
  expect(work.offer(structuredClone(saved), run)).toBeUndefined();
  work.beginClose();
  let joined = false;
  const stop = work.stop().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  release.resolve();
  await wake;
  await stop;
  await tracked.drain();
  expect(calls).toBe(2);
  expect(clock.armedAtMs).toBeNull();
  await scheduler.stop();
});

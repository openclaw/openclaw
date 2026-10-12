import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Question } from "../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { QuestionManager } from "./question-manager.js";

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

let manager: QuestionManager;
let clock: ReturnType<typeof createGatewaySchedulerClock>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  clock = createGatewaySchedulerClock(1_000);
  manager = new QuestionManager(createTestGatewayScheduler(clock.clock));
});

afterEach(async () => {
  manager.close();
  await manager.drain();
  vi.useRealTimers();
});

describe("QuestionManager monotonic expiry deadline", () => {
  it("does not expire early when the wall clock jumps forward", async () => {
    const record = manager.request({ questions, timeoutMs: 50_000 });
    clock.setTime(60_000);
    expect(manager.get(record.id)?.status).toBe("pending");
    await clock.wakeDueToWallClock();
    expect(manager.list()).toHaveLength(1);
    // The early wake re-armed the remaining monotonic budget. Advancing past
    // it must still expire the question — proving the re-arm was not lost.
    await clock.advanceBy(50_000);
    expect(manager.get(record.id)?.status).toBe("expired");
  });

  it("rearms expiry when a scheduled wake overlaps an in-flight commit", async () => {
    const commit = createDeferredCore();
    const record = manager.request({ questions, timeoutMs: 50_000 });
    const waiting = manager.waitAnswer(record.id);
    const pending = manager.resolveWithCommit(record.id, answers, undefined, {
      commit: () => commit.promise,
    });
    // A wall-clock forward jump trips the scheduled wake before the monotonic
    // deadline while committing; the wake must re-arm a future expiry so a
    // failed commit still reaches a terminal outcome without a later get/list.
    clock.setTime(60_000);
    void clock.wakeDueToWallClock();
    commit.reject(new Error("commit failed"));
    await expect(pending).rejects.toThrow("commit failed");
    await clock.advanceBy(50_000);
    await expect(waiting).resolves.toEqual({ status: "expired" });
  });

  it("expires on monotonic time even when the wall clock jumps backward", async () => {
    const record = manager.request({ questions, timeoutMs: 50 });
    // Rewind the wall clock below the creation time. A wall-clock-based check
    // would never expire; the monotonic deadline must still fire.
    clock.setTime(0);
    await clock.advanceBy(50);
    expect(manager.get(record.id)?.status).toBe("expired");
  });
});

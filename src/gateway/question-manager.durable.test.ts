import { describe, expect, it, vi } from "vitest";
import type { QuestionRecord } from "../../packages/gateway-protocol/src/index.js";
import { SessionQuestionCustodyRetiredError } from "../config/sessions/session-questions-custody-error.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { QuestionManager } from "./question-manager.js";

const record: QuestionRecord = {
  id: "durable",
  agentId: "main",
  sessionKey: "agent:main:proof",
  runId: "asking",
  createdAtMs: 100,
  expiresAtMs: 1000,
  status: "pending",
  questions: [
    { questionId: "choice", header: "Choice", question: "Proceed?", options: [{ label: "Yes" }] },
  ],
};
const answers = { answers: { choice: ["Yes"] } };

describe("durable question observations", () => {
  it("keeps custody after asking-run retirement and publishes only canonical committed truth", async () => {
    const clock = createGatewaySchedulerClock(100);
    const manager = new QuestionManager(createTestGatewayScheduler(clock.clock));
    const commit = createDeferredCore<{ record: QuestionRecord; resolutionId: string }>();
    const published = vi.fn();
    const owed = vi.fn();
    manager.request({
      questions: record.questions,
      timeoutMs: 900,
      storedRecord: record,
      isRequesterActive: () => false,
      durableCustody: { settle: () => commit.promise, onContinuationOwed: owed },
      onResolved: published,
    });
    manager.cancelClosedAuthorities({ runId: "asking" });
    expect(manager.get("durable")?.status).toBe("pending");
    const settlement = manager.settleDurable("durable", { status: "answered", answers }, () => {});
    expect(published).not.toHaveBeenCalled();
    expect(owed).not.toHaveBeenCalled();
    commit.resolve({
      record: { ...record, status: "cancelled", resolvedBy: "first-terminal" },
      resolutionId: "first",
    });
    expect(await settlement).toEqual({ status: "cancelled" });
    expect(published.mock.calls[0]?.[0]).toEqual({ id: "durable", status: "cancelled" });
    await clock.advanceTo(20_000);
    expect(manager.get("durable")?.resolvedBy).toBe("first-terminal");
    manager.close();
    await manager.drain();
  });

  it("retries unavailable expiry with bounded lifecycle backoff after a failed answer consumes its deadline", async () => {
    const clock = createGatewaySchedulerClock(100);
    const failed = vi.fn(() => {
      throw new Error("publication observer failed");
    });
    const manager = new QuestionManager(createTestGatewayScheduler(clock.clock), failed);
    const commit = createDeferredCore<{ record: QuestionRecord }>();
    let databaseAvailable = false;
    const settle = vi.fn((outcome: { status: string }) =>
      outcome.status === "expired"
        ? databaseAvailable
          ? Promise.resolve({ record: { ...record, status: "expired" as const } })
          : Promise.reject(new Error("database unavailable"))
        : commit.promise,
    );
    manager.request({
      questions: record.questions,
      timeoutMs: 900,
      storedRecord: record,
      durableCustody: { settle, onContinuationOwed: () => {} },
    });
    const settlement = manager.settleDurable("durable", { status: "answered", answers }, () => {});
    const rejection = expect(settlement).rejects.toThrow("answer failed");
    // The scheduled wake waits for the deliberately held commit to drain.
    const deadlineWake = clock.advanceTo(1000);
    expect(settle).toHaveBeenCalledTimes(1);
    commit.reject(new Error("answer failed"));
    await rejection;
    await deadlineWake;
    await manager.drain();
    expect(settle.mock.calls.map(([outcome]) => outcome.status)).toEqual(["answered", "expired"]);
    expect(manager.observe("durable")?.record.status).toBe("pending");
    expect(clock.armedAtMs).toBe(2000);
    expect(manager.get("durable")?.expiresAtMs).toBe(1000);
    await clock.advanceTo(1999);
    expect(manager.get("durable")?.status).toBe("pending");
    expect(settle).toHaveBeenCalledTimes(2);
    databaseAvailable = true;
    await clock.advanceTo(2000);
    await manager.drain();
    expect(settle).toHaveBeenCalledTimes(3);
    expect(manager.observe("durable")?.record).toMatchObject({
      status: "expired",
      expiresAtMs: 1000,
    });
    expect(clock.armedAtMs).toBeNull();
    expect(failed).toHaveBeenCalledOnce();
    manager.close();
    await manager.drain();
  });

  it("cancels an unavailable expiry retry when its exact custody is retired", async () => {
    const clock = createGatewaySchedulerClock(950);
    const manager = new QuestionManager(createTestGatewayScheduler(clock.clock));
    const settle = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    manager.request({
      questions: record.questions,
      timeoutMs: 900,
      storedRecord: record,
      durableCustody: { settle, onContinuationOwed: () => {} },
    });
    await clock.advanceTo(1000);
    await manager.drain();
    expect(clock.armedAtMs).toBe(2000);
    manager.reset();
    await clock.advanceTo(60_000);
    expect(settle).toHaveBeenCalledOnce();
    expect(manager.observe("durable")).toBeNull();
    manager.close();
    await manager.drain();
  });

  it("retires only the exact expired observation when the native custody owner was replaced", async () => {
    const clock = createGatewaySchedulerClock(950);
    const manager = new QuestionManager(createTestGatewayScheduler(clock.clock));
    const settle = vi.fn(async () => {
      throw new SessionQuestionCustodyRetiredError("Original custody replaced");
    });
    const published = vi.fn();
    const owed = vi.fn();
    manager.request({
      questions: record.questions,
      timeoutMs: 900,
      storedRecord: record,
      durableCustody: { settle, onContinuationOwed: owed },
      onResolved: published,
    });
    await clock.advanceTo(1000);
    await manager.drain();
    expect(manager.observe("durable")).toBeNull();
    expect(clock.armedAtMs).toBeNull();
    expect(published).not.toHaveBeenCalled();
    expect(owed).not.toHaveBeenCalled();
    await clock.advanceTo(60_000);
    expect(settle).toHaveBeenCalledOnce();
    manager.close();
    await manager.drain();
  });

  it("restores an absolute pending deadline and does not rearm terminal receipts", async () => {
    const clock = createGatewaySchedulerClock(950);
    const manager = new QuestionManager(createTestGatewayScheduler(clock.clock));
    const settle = vi.fn(async () => ({ record: { ...record, status: "expired" as const } }));
    manager.request({
      questions: record.questions,
      timeoutMs: 900,
      storedRecord: record,
      durableCustody: { settle, onContinuationOwed: () => {} },
    });
    expect(clock.armedAtMs).toBe(1000);
    await clock.advanceTo(1000);
    await manager.drain();
    expect(settle).toHaveBeenCalledWith(
      { status: "expired" },
      expect.any(Function),
      expect.any(Function),
    );
    expect(manager.get("durable")?.status).toBe("expired");
    manager.close();
    const restored = new QuestionManager(createTestGatewayScheduler(clock.clock));
    restored.request({
      questions: record.questions,
      timeoutMs: 900,
      storedRecord: { ...record, status: "answered", answers },
      storedResolutionId: "canonical-answer",
      durableCustody: { settle, onContinuationOwed: () => {} },
    });
    expect(clock.armedAtMs).toBeNull();
    expect(restored.list()).toEqual([]);
    expect(restored.list(undefined, true)).toEqual([{ ...record, status: "answered", answers }]);
    expect(await restored.waitAnswer("durable", undefined, true)).toEqual({
      status: "answered",
      answers,
      resolutionId: "canonical-answer",
    });
    restored.retireDurableObservationAt(restored.observe("durable")!, 60_000);
    expect(clock.armedAtMs).toBe(60_000);
    await clock.advanceTo(59_999);
    expect(restored.get("durable")?.status).toBe("answered");
    await clock.advanceTo(60_000);
    expect(restored.get("durable")).toBeNull();
    restored.close();
    await restored.drain();
  });
});

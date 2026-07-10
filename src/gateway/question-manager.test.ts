/**
 * Tests the question manager: register/resolve/expire, promise parking, emitter
 * fan-out, no-default-timeout behavior, and pending listing/visibility filtering.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentHarnessUserInputQuestion } from "../agents/harness/user-input-bridge.js";
import { QuestionManager, type QuestionEmitter, type QuestionRecord } from "./question-manager.js";

const QUESTIONS: readonly AgentHarnessUserInputQuestion[] = [
  {
    id: "q1",
    header: "Deploy",
    question: "Ship it?",
    options: [{ label: "Yes (Recommended)" }, { label: "No" }],
    isOther: true,
  },
];

describe("QuestionManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parks a promise that resolves with the submitted answers", async () => {
    const manager = new QuestionManager();
    const { record, wait } = manager.register({ questions: QUESTIONS, sessionKey: "s1" });
    expect(record.status).toBe("pending");
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const ok = manager.resolve(record.id, { q1: { text: "Yes (Recommended)" } }, "operator");
    expect(ok).toBe(true);
    await expect(wait).resolves.toEqual({ q1: { text: "Yes (Recommended)" } });
    expect(manager.getSnapshot(record.id)?.status).toBe("resolved");
    expect(manager.getSnapshot(record.id)?.resolvedBy).toBe("operator");
  });

  it("expire settles the promise with null and no answers", async () => {
    const manager = new QuestionManager();
    const { record, wait } = manager.register({ questions: QUESTIONS });
    expect(manager.expire(record.id, "shutdown")).toBe(true);
    await expect(wait).resolves.toBeNull();
    expect(manager.getSnapshot(record.id)?.status).toBe("expired");
  });

  it("rejects double-resolve and resolve-after-expire", async () => {
    const manager = new QuestionManager();
    const { record } = manager.register({ questions: QUESTIONS });
    expect(manager.resolve(record.id, { q1: { text: "Yes" } })).toBe(true);
    expect(manager.resolve(record.id, { q1: { text: "No" } })).toBe(false);
    const second = manager.register({ questions: QUESTIONS });
    expect(manager.expire(second.record.id, "x")).toBe(true);
    expect(manager.resolve(second.record.id, { q1: { text: "No" } })).toBe(false);
  });

  it("does NOT arm a timer when no expiry is provided", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const manager = new QuestionManager();
    manager.register({ questions: QUESTIONS });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("honors an explicit expiresAtMs by auto-expiring", () => {
    vi.useFakeTimers();
    try {
      const manager = new QuestionManager();
      const emitter: QuestionEmitter = { onExpired: vi.fn() };
      manager.setEmitter(emitter);
      const { record } = manager.register({
        questions: QUESTIONS,
        expiresAtMs: Date.now() + 1_000,
      });
      vi.advanceTimersByTime(1_001);
      expect(manager.getSnapshot(record.id)?.status).toBe("expired");
      expect(emitter.onExpired).toHaveBeenCalledWith(
        expect.objectContaining({ id: record.id }),
        "timeout",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires emitter hooks in order: pending then resolved", () => {
    const events: string[] = [];
    const emitter: QuestionEmitter = {
      onPending: () => events.push("pending"),
      onResolved: () => events.push("resolved"),
    };
    const manager = new QuestionManager();
    manager.setEmitter(emitter);
    const { record } = manager.register({ questions: QUESTIONS });
    manager.resolve(record.id, { q1: { text: "Yes" } });
    expect(events).toEqual(["pending", "resolved"]);
  });

  it("list returns only pending records and applies the visibility filter", () => {
    const manager = new QuestionManager();
    const a = manager.register({ questions: QUESTIONS, turnSourceChannel: "telegram" });
    const b = manager.register({ questions: QUESTIONS, turnSourceChannel: "slack" });
    manager.resolve(b.record.id, { q1: { text: "No" } });
    const visible = manager.list(
      (record: QuestionRecord) => record.turnSourceChannel === "telegram",
    );
    expect(visible.map((r) => r.id)).toEqual([a.record.id]);
  });

  it("throws when registering a duplicate explicit id", () => {
    const manager = new QuestionManager();
    manager.register({ id: "dup", questions: QUESTIONS });
    expect(() => manager.register({ id: "dup", questions: QUESTIONS })).toThrow(/already pending/);
  });
});

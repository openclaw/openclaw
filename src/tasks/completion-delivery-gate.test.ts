import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  claimCompletionDelivery,
  getCompletionClaim,
  isCompletionClaimed,
  resolveCompletionKeyFromTask,
  type CompletionKey,
} from "./completion-delivery-gate.js";
import type { TaskRecord } from "./task-registry.types.js";

function makeKey(overrides?: Partial<CompletionKey>): CompletionKey {
  return {
    runtime: "acp",
    runId: "run-001",
    ownerSessionKey: "session-owner-1",
    ...overrides,
  };
}

function makeTaskRecord(overrides?: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: "task-1",
    runtime: "acp",
    requesterSessionKey: "session-req-1",
    ownerKey: "session-owner-1",
    scopeKind: "session",
    runId: "run-001",
    task: "test task",
    status: "succeeded",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("CompletionDeliveryGate", () => {
  beforeEach(() => {
    __testing.resetGate();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __testing.resetGate();
  });

  describe("gate mode = off (default)", () => {
    it("always grants claims in transparent mode", () => {
      const key = makeKey();
      const r1 = claimCompletionDelivery(key, "task_registry", "visible_banner");
      const r2 = claimCompletionDelivery(key, "announce_flow", "announce_synthesized");
      expect(r1.claimed).toBe(true);
      expect(r2.claimed).toBe(true);
    });

    it("isCompletionClaimed returns false in transparent mode", () => {
      const key = makeKey();
      claimCompletionDelivery(key, "task_registry", "visible_banner");
      expect(isCompletionClaimed(key)).toBe(false);
    });
  });

  describe("gate mode = on", () => {
    beforeEach(() => {
      vi.stubEnv("OPENCLAW_COMPLETION_GATE", "1");
    });

    it("first claim wins", () => {
      const key = makeKey();
      const r1 = claimCompletionDelivery(key, "announce_flow", "announce_synthesized");
      expect(r1.claimed).toBe(true);

      const r2 = claimCompletionDelivery(key, "task_registry", "visible_banner");
      expect(r2.claimed).toBe(false);
      if (!r2.claimed) {
        expect(r2.claimedBy).toBe("announce_flow");
      }
    });

    it("same source re-claiming is idempotent", () => {
      const key = makeKey();
      const r1 = claimCompletionDelivery(key, "task_registry", "visible_banner");
      const r2 = claimCompletionDelivery(key, "task_registry", "visible_banner");
      expect(r1.claimed).toBe(true);
      expect(r2.claimed).toBe(true);
      if (r1.claimed && r2.claimed) {
        expect(r1.deliveryId).toBe(r2.deliveryId);
      }
    });

    it("different runs are independent", () => {
      const key1 = makeKey({ runId: "run-001" });
      const key2 = makeKey({ runId: "run-002" });
      const r1 = claimCompletionDelivery(key1, "announce_flow", "announce_synthesized");
      const r2 = claimCompletionDelivery(key2, "task_registry", "visible_banner");
      expect(r1.claimed).toBe(true);
      expect(r2.claimed).toBe(true);
    });

    it("different owner sessions are independent", () => {
      const key1 = makeKey({ ownerSessionKey: "owner-a" });
      const key2 = makeKey({ ownerSessionKey: "owner-b" });
      const r1 = claimCompletionDelivery(key1, "announce_flow", "announce_synthesized");
      const r2 = claimCompletionDelivery(key2, "announce_flow", "announce_synthesized");
      expect(r1.claimed).toBe(true);
      expect(r2.claimed).toBe(true);
    });

    it("isCompletionClaimed reflects state", () => {
      const key = makeKey();
      expect(isCompletionClaimed(key)).toBe(false);
      claimCompletionDelivery(key, "silent_wake", "silent_wake");
      expect(isCompletionClaimed(key)).toBe(true);
    });

    it("getCompletionClaim returns the claim record", () => {
      const key = makeKey();
      expect(getCompletionClaim(key)).toBeUndefined();
      claimCompletionDelivery(key, "announce_flow", "announce_synthesized");
      const claim = getCompletionClaim(key);
      expect(claim).toBeDefined();
      expect(claim?.claimedBy).toBe("announce_flow");
      expect(claim?.deliveryMode).toBe("announce_synthesized");
    });

    it("blocks task_registry when silent_wake already claimed", () => {
      const key = makeKey();
      claimCompletionDelivery(key, "silent_wake", "silent_wake");
      const r = claimCompletionDelivery(key, "task_registry", "visible_banner");
      expect(r.claimed).toBe(false);
    });

    it("blocks announce_flow when task_registry already claimed", () => {
      const key = makeKey();
      claimCompletionDelivery(key, "task_registry", "visible_banner");
      const r = claimCompletionDelivery(key, "announce_flow", "announce_synthesized");
      expect(r.claimed).toBe(false);
    });
  });

  describe("gate mode = shadow", () => {
    beforeEach(() => {
      vi.stubEnv("OPENCLAW_COMPLETION_GATE", "shadow");
    });

    it("logs but does not block", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const key = makeKey();
      claimCompletionDelivery(key, "announce_flow", "announce_synthesized");
      const r = claimCompletionDelivery(key, "task_registry", "visible_banner");
      expect(r.claimed).toBe(true);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("[completion-gate:shadow-block]"),
      );
      stderrSpy.mockRestore();
    });
  });

  describe("resolveCompletionKeyFromTask", () => {
    it("returns a key from a valid task record", () => {
      const task = makeTaskRecord();
      const key = resolveCompletionKeyFromTask(task);
      expect(key).toEqual({
        runtime: "acp",
        runId: "run-001",
        ownerSessionKey: "session-owner-1",
      });
    });

    it("returns null when runId is missing", () => {
      const task = makeTaskRecord({ runId: undefined });
      expect(resolveCompletionKeyFromTask(task)).toBeNull();
    });

    it("returns null when ownerKey is empty", () => {
      const task = makeTaskRecord({ ownerKey: "  " });
      expect(resolveCompletionKeyFromTask(task)).toBeNull();
    });
  });
});

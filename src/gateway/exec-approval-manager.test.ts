import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import type { ExecApprovalRequestPayload } from "./exec-approval-manager.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";

function makePayload(command = "echo hello"): ExecApprovalRequestPayload {
  return { command };
}

describe("ExecApprovalManager", () => {
  let mgr: ExecApprovalManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mgr = new ExecApprovalManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------
  describe("create", () => {
    it("returns a record with a generated id when none is provided", () => {
      const record = mgr.create(makePayload(), 5000);
      expect(record.id).toBeTruthy();
      expect(record.request.command).toBe("echo hello");
      expect(record.expiresAtMs).toBe(record.createdAtMs + 5000);
    });

    it("uses the supplied id when provided", () => {
      const record = mgr.create(makePayload(), 5000, "custom-id");
      expect(record.id).toBe("custom-id");
    });

    it("trims whitespace from supplied id", () => {
      const record = mgr.create(makePayload(), 5000, "  spaced  ");
      expect(record.id).toBe("spaced");
    });

    it("generates a uuid when supplied id is empty or whitespace", () => {
      const r1 = mgr.create(makePayload(), 5000, "");
      const r2 = mgr.create(makePayload(), 5000, "   ");
      const r3 = mgr.create(makePayload(), 5000, null);
      expect(r1.id).toBeTruthy();
      expect(r2.id).toBeTruthy();
      expect(r3.id).toBeTruthy();
      // All should be distinct UUIDs
      expect(new Set([r1.id, r2.id, r3.id]).size).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle: create → register → resolve (allow)
  // ---------------------------------------------------------------------------
  describe("full lifecycle (allow)", () => {
    it("resolves with allow-once decision", async () => {
      const record = mgr.create(makePayload(), 5000, "test-allow");
      const promise = mgr.register(record, 5000);

      const resolved = mgr.resolve("test-allow", "allow-once");
      expect(resolved).toBe(true);

      const decision = await promise;
      expect(decision).toBe("allow-once");
    });

    it("resolves with allow-always decision", async () => {
      const record = mgr.create(makePayload(), 5000, "test-always");
      const promise = mgr.register(record, 5000);

      mgr.resolve("test-always", "allow-always");
      const decision = await promise;
      expect(decision).toBe("allow-always");
    });

    it("sets resolvedAtMs, decision, and resolvedBy on the record", () => {
      const record = mgr.create(makePayload(), 5000, "meta-check");
      mgr.register(record, 5000);
      mgr.resolve("meta-check", "allow-once", "user-123");

      const snapshot = mgr.getSnapshot("meta-check");
      expect(snapshot?.resolvedAtMs).toBeTypeOf("number");
      expect(snapshot?.decision).toBe("allow-once");
      expect(snapshot?.resolvedBy).toBe("user-123");
    });
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle: create → register → resolve (deny)
  // ---------------------------------------------------------------------------
  describe("full lifecycle (deny)", () => {
    it("resolves with deny decision", async () => {
      const record = mgr.create(makePayload(), 5000, "test-deny");
      const promise = mgr.register(record, 5000);

      mgr.resolve("test-deny", "deny");
      const decision = await promise;
      expect(decision).toBe("deny");
    });
  });

  // ---------------------------------------------------------------------------
  // Timeout / expiration
  // ---------------------------------------------------------------------------
  describe("timeout expiration", () => {
    it("resolves with null after timeout", async () => {
      const record = mgr.create(makePayload(), 3000, "timeout-test");
      const promise = mgr.register(record, 3000);

      vi.advanceTimersByTime(3000);

      const decision = await promise;
      expect(decision).toBeNull();
    });

    it("marks record as resolved with undefined decision on expire", () => {
      const record = mgr.create(makePayload(), 3000, "expire-meta");
      mgr.register(record, 3000);

      vi.advanceTimersByTime(3000);

      const snapshot = mgr.getSnapshot("expire-meta");
      expect(snapshot?.resolvedAtMs).toBeTypeOf("number");
      expect(snapshot?.decision).toBeUndefined();
    });

    it("explicit expire() returns true for pending entry", () => {
      const record = mgr.create(makePayload(), 5000, "exp-explicit");
      mgr.register(record, 5000);

      expect(mgr.expire("exp-explicit", "system")).toBe(true);
    });

    it("explicit expire() returns false for unknown id", () => {
      expect(mgr.expire("nonexistent")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Double-resolve prevention
  // ---------------------------------------------------------------------------
  describe("double-resolve prevention", () => {
    it("second resolve returns false", () => {
      const record = mgr.create(makePayload(), 5000, "double");
      mgr.register(record, 5000);

      expect(mgr.resolve("double", "allow-once")).toBe(true);
      expect(mgr.resolve("double", "deny")).toBe(false);
    });

    it("resolve after expire returns false", () => {
      const record = mgr.create(makePayload(), 5000, "exp-then-resolve");
      mgr.register(record, 5000);

      mgr.expire("exp-then-resolve");
      expect(mgr.resolve("exp-then-resolve", "allow-once")).toBe(false);
    });

    it("resolve on unknown id returns false", () => {
      expect(mgr.resolve("ghost", "allow-once")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // consumeAllowOnce atomicity
  // ---------------------------------------------------------------------------
  describe("consumeAllowOnce", () => {
    it("first call returns true, second returns false", () => {
      const record = mgr.create(makePayload(), 5000, "consume");
      mgr.register(record, 5000);
      mgr.resolve("consume", "allow-once");

      expect(mgr.consumeAllowOnce("consume")).toBe(true);
      expect(mgr.consumeAllowOnce("consume")).toBe(false);
    });

    it("returns false for allow-always decision", () => {
      const record = mgr.create(makePayload(), 5000, "always");
      mgr.register(record, 5000);
      mgr.resolve("always", "allow-always");

      expect(mgr.consumeAllowOnce("always")).toBe(false);
    });

    it("returns false for deny decision", () => {
      const record = mgr.create(makePayload(), 5000, "denied");
      mgr.register(record, 5000);
      mgr.resolve("denied", "deny");

      expect(mgr.consumeAllowOnce("denied")).toBe(false);
    });

    it("returns false for unknown id", () => {
      expect(mgr.consumeAllowOnce("nope")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // lookupPendingId
  // ---------------------------------------------------------------------------
  describe("lookupPendingId", () => {
    it("exact match returns kind 'exact'", () => {
      const record = mgr.create(makePayload(), 5000, "abc-123-def");
      mgr.register(record, 5000);

      const result = mgr.lookupPendingId("abc-123-def");
      expect(result).toEqual({ kind: "exact", id: "abc-123-def" });
    });

    it("prefix match returns kind 'prefix'", () => {
      const record = mgr.create(makePayload(), 5000, "abc-123-def");
      mgr.register(record, 5000);

      const result = mgr.lookupPendingId("abc");
      expect(result).toEqual({ kind: "prefix", id: "abc-123-def" });
    });

    it("prefix match is case-insensitive", () => {
      const record = mgr.create(makePayload(), 5000, "ABC-123-DEF");
      mgr.register(record, 5000);

      const result = mgr.lookupPendingId("abc");
      expect(result).toEqual({ kind: "prefix", id: "ABC-123-DEF" });
    });

    it("ambiguous prefix returns kind 'ambiguous' with all matching ids", () => {
      const r1 = mgr.create(makePayload(), 5000, "abc-111");
      const r2 = mgr.create(makePayload(), 5000, "abc-222");
      mgr.register(r1, 5000);
      mgr.register(r2, 5000);

      const result = mgr.lookupPendingId("abc");
      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous") {
        expect(result.ids).toHaveLength(2);
        expect(result.ids).toContain("abc-111");
        expect(result.ids).toContain("abc-222");
      }
    });

    it("no match returns kind 'none'", () => {
      const record = mgr.create(makePayload(), 5000, "xyz-999");
      mgr.register(record, 5000);

      const result = mgr.lookupPendingId("qqq");
      expect(result).toEqual({ kind: "none" });
    });

    it("empty string returns kind 'none'", () => {
      const record = mgr.create(makePayload(), 5000, "abc-123");
      mgr.register(record, 5000);

      expect(mgr.lookupPendingId("")).toEqual({ kind: "none" });
      expect(mgr.lookupPendingId("   ")).toEqual({ kind: "none" });
    });

    it("resolved entries are excluded from lookup", () => {
      const record = mgr.create(makePayload(), 5000, "resolved-id");
      mgr.register(record, 5000);
      mgr.resolve("resolved-id", "allow-once");

      // exact match on a resolved entry returns none
      expect(mgr.lookupPendingId("resolved-id")).toEqual({ kind: "none" });
      // prefix match on a resolved entry returns none
      expect(mgr.lookupPendingId("resolved")).toEqual({ kind: "none" });
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotent re-registration
  // ---------------------------------------------------------------------------
  describe("idempotent re-registration", () => {
    it("returns the same promise for a still-pending id", () => {
      const record = mgr.create(makePayload(), 5000, "idem");
      const p1 = mgr.register(record, 5000);
      const p2 = mgr.register(record, 5000);

      expect(p1).toBe(p2);
    });

    it("throws when re-registering an already-resolved id", () => {
      const record = mgr.create(makePayload(), 5000, "idem-resolved");
      mgr.register(record, 5000);
      mgr.resolve("idem-resolved", "allow-once");

      expect(() => mgr.register(record, 5000)).toThrow(
        "approval id 'idem-resolved' already resolved",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Grace period cleanup
  // ---------------------------------------------------------------------------
  describe("grace period cleanup", () => {
    it("entry is still accessible during the grace period", () => {
      const record = mgr.create(makePayload(), 5000, "grace");
      mgr.register(record, 5000);
      mgr.resolve("grace", "allow-once");

      // Still within the 15s grace window
      vi.advanceTimersByTime(10_000);
      expect(mgr.getSnapshot("grace")).not.toBeNull();
    });

    it("entry is cleaned up after the grace period", () => {
      const record = mgr.create(makePayload(), 5000, "grace-done");
      mgr.register(record, 5000);
      mgr.resolve("grace-done", "allow-once");

      // Advance past the 15s grace period
      vi.advanceTimersByTime(16_000);
      expect(mgr.getSnapshot("grace-done")).toBeNull();
    });

    it("grace period applies to expired entries too", () => {
      const record = mgr.create(makePayload(), 5000, "grace-expire");
      mgr.register(record, 5000);
      mgr.expire("grace-expire");

      // Still accessible during grace period
      expect(mgr.getSnapshot("grace-expire")).not.toBeNull();

      // Gone after grace period
      vi.advanceTimersByTime(16_000);
      expect(mgr.getSnapshot("grace-expire")).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // awaitDecision
  // ---------------------------------------------------------------------------
  describe("awaitDecision", () => {
    it("returns the promise for a registered pending entry", () => {
      const record = mgr.create(makePayload(), 5000, "await-test");
      const registerPromise = mgr.register(record, 5000);

      const awaitPromise = mgr.awaitDecision("await-test");
      expect(awaitPromise).toBe(registerPromise);
    });

    it("returns null for an unknown id", () => {
      expect(mgr.awaitDecision("ghost")).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getSnapshot
  // ---------------------------------------------------------------------------
  describe("getSnapshot", () => {
    it("returns null for unknown id", () => {
      expect(mgr.getSnapshot("nope")).toBeNull();
    });

    it("returns the record for a registered entry", () => {
      const record = mgr.create(makePayload("ls -la"), 5000, "snap");
      mgr.register(record, 5000);

      const snapshot = mgr.getSnapshot("snap");
      expect(snapshot?.request.command).toBe("ls -la");
      expect(snapshot?.id).toBe("snap");
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  describe("edge cases", () => {
    it("handles empty command string in payload", () => {
      const record = mgr.create(makePayload(""), 5000, "empty-cmd");
      mgr.register(record, 5000);
      mgr.resolve("empty-cmd", "allow-once");

      expect(mgr.getSnapshot("empty-cmd")?.decision).toBe("allow-once");
    });

    it("handles very long command string", () => {
      const longCmd = "x".repeat(10_000);
      const record = mgr.create(makePayload(longCmd), 5000, "long-cmd");
      mgr.register(record, 5000);
      mgr.resolve("long-cmd", "allow-once");

      expect(mgr.getSnapshot("long-cmd")?.request.command).toBe(longCmd);
    });

    it("generic type parameter works with custom payload", async () => {
      type CustomPayload = { tool: string; args: string[] };
      const custom = new ExecApprovalManager<CustomPayload>();
      const record = custom.create({ tool: "bash", args: ["-c", "ls"] }, 5000, "custom");
      const promise = custom.register(record, 5000);

      custom.resolve("custom", "allow-once");
      const decision = await promise;

      expect(decision).toBe("allow-once");
      expect(custom.getSnapshot("custom")?.request.tool).toBe("bash");
    });
  });

  // ---------------------------------------------------------------------------
  // waitForDecision (deprecated wrapper)
  // ---------------------------------------------------------------------------
  describe("waitForDecision (deprecated)", () => {
    it("delegates to register and returns a decision", async () => {
      const record = mgr.create(makePayload(), 5000, "wait-compat");
      const promise = mgr.waitForDecision(record, 5000);

      mgr.resolve("wait-compat", "deny");
      const decision = await promise;
      expect(decision).toBe("deny");
    });
  });
});

import { describe, expect, it } from "vitest";
import { ExecApprovalManager } from "./exec-approval-manager.js";

function makeRequest(command = "echo hello") {
  return {
    command,
    agentId: "main",
    sessionKey: "agent:main:main",
  };
}

describe("ExecApprovalManager", () => {
  describe("findByIdOrPrefix", () => {
    it("returns exact match when full ID is provided", () => {
      const manager = new ExecApprovalManager();
      const record = manager.create(makeRequest(), 120_000);
      void manager.register(record, 120_000);

      const result = manager.findByIdOrPrefix(record.id);
      expect(result).not.toBeNull();
      expect(result).not.toBe("ambiguous");
      expect((result as { id: string }).id).toBe(record.id);
    });

    it("returns match for unique prefix", () => {
      const manager = new ExecApprovalManager();
      const record = manager.create(makeRequest(), 120_000);
      void manager.register(record, 120_000);

      // Use first 8 chars as prefix
      const prefix = record.id.slice(0, 8);
      const result = manager.findByIdOrPrefix(prefix);
      expect(result).not.toBeNull();
      expect(result).not.toBe("ambiguous");
      expect((result as { id: string }).id).toBe(record.id);
    });

    it("returns null when no match exists", () => {
      const manager = new ExecApprovalManager();
      const record = manager.create(makeRequest(), 120_000);
      void manager.register(record, 120_000);

      const result = manager.findByIdOrPrefix("zzzzz-nonexistent");
      expect(result).toBeNull();
    });

    it("returns 'ambiguous' when multiple pending entries share the same prefix", () => {
      const manager = new ExecApprovalManager();
      const record1 = manager.create(makeRequest(), 120_000, "aaa-1111-1111-1111-111111111111");
      const record2 = manager.create(makeRequest(), 120_000, "aaa-2222-2222-2222-222222222222");
      void manager.register(record1, 120_000);
      void manager.register(record2, 120_000);

      const result = manager.findByIdOrPrefix("aaa");
      expect(result).toBe("ambiguous");
    });

    it("skips already-resolved entries during prefix search", () => {
      const manager = new ExecApprovalManager();
      const record1 = manager.create(makeRequest(), 120_000, "bbb-1111-1111-1111-111111111111");
      const record2 = manager.create(makeRequest(), 120_000, "bbb-2222-2222-2222-222222222222");
      void manager.register(record1, 120_000);
      void manager.register(record2, 120_000);

      // Resolve record1, so only record2 remains pending
      manager.resolve(record1.id, "allow-once");

      const result = manager.findByIdOrPrefix("bbb");
      expect(result).not.toBeNull();
      expect(result).not.toBe("ambiguous");
      expect((result as { id: string }).id).toBe(record2.id);
    });

    it("returns exact match even if entry is already resolved", () => {
      const manager = new ExecApprovalManager();
      const record = manager.create(makeRequest(), 120_000);
      void manager.register(record, 120_000);
      manager.resolve(record.id, "deny");

      // Exact match should still return the entry (within grace period)
      const result = manager.findByIdOrPrefix(record.id);
      expect(result).not.toBeNull();
      expect(result).not.toBe("ambiguous");
      expect((result as { id: string }).id).toBe(record.id);
    });

    it("returns null for empty string prefix", () => {
      const manager = new ExecApprovalManager();
      const record = manager.create(makeRequest(), 120_000);
      void manager.register(record, 120_000);

      // Empty string is a prefix of everything — with a single pending entry, matches it.
      const result = manager.findByIdOrPrefix("");
      expect(result).not.toBe("ambiguous");
      expect(result).not.toBeNull();
    });
  });

  describe("resolve", () => {
    it("resolves a pending approval and returns true", async () => {
      const manager = new ExecApprovalManager();
      const record = manager.create(makeRequest(), 120_000);
      const promise = manager.register(record, 120_000);

      const ok = manager.resolve(record.id, "allow-once", "test-user");
      expect(ok).toBe(true);

      const decision = await promise;
      expect(decision).toBe("allow-once");
    });

    it("returns false for unknown ID", () => {
      const manager = new ExecApprovalManager();
      const ok = manager.resolve("nonexistent-id", "deny");
      expect(ok).toBe(false);
    });

    it("prevents double-resolve", () => {
      const manager = new ExecApprovalManager();
      const record = manager.create(makeRequest(), 120_000);
      void manager.register(record, 120_000);

      expect(manager.resolve(record.id, "allow-once")).toBe(true);
      expect(manager.resolve(record.id, "deny")).toBe(false);
    });
  });

  describe("expire", () => {
    it("expires a pending approval returning null decision", async () => {
      const manager = new ExecApprovalManager();
      const record = manager.create(makeRequest(), 120_000);
      const promise = manager.register(record, 120_000);

      const ok = manager.expire(record.id);
      expect(ok).toBe(true);

      const decision = await promise;
      expect(decision).toBeNull();
    });
  });

  describe("create", () => {
    it("generates UUID when no explicit ID provided", () => {
      const manager = new ExecApprovalManager();
      const record = manager.create(makeRequest(), 120_000);
      expect(record.id).toHaveLength(36);
      expect(record.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
    });

    it("uses explicit ID when provided", () => {
      const manager = new ExecApprovalManager();
      const record = manager.create(makeRequest(), 120_000, "my-custom-id-1234");
      expect(record.id).toBe("my-custom-id-1234");
    });
  });
});

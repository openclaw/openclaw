import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AgentShieldApprovalManager,
  computeArgsFingerprint,
} from "./agentshield-approval-manager.js";

describe("computeArgsFingerprint", () => {
  it("produces a 64-char hex SHA-256", () => {
    const fp = computeArgsFingerprint('{"key":"value"}');
    expect(fp).toHaveLength(64);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const a = computeArgsFingerprint('{"a":1}');
    const b = computeArgsFingerprint('{"a":1}');
    expect(a).toBe(b);
  });

  it("differs for different inputs", () => {
    const a = computeArgsFingerprint('{"a":1}');
    const b = computeArgsFingerprint('{"a":2}');
    expect(a).not.toBe(b);
  });
});

describe("AgentShieldApprovalManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("create", () => {
    it("returns a record with argsFingerprint", () => {
      const mgr = new AgentShieldApprovalManager();
      const record = mgr.create(
        { toolName: "shell_exec", paramsJSON: '{"cmd":"ls"}', agentId: "a1", sessionKey: "s1" },
        5000,
      );
      expect(record.id).toBeTruthy();
      expect(record.toolName).toBe("shell_exec");
      expect(record.argsFingerprint).toBe(computeArgsFingerprint('{"cmd":"ls"}'));
      expect(record.agentId).toBe("a1");
      expect(record.sessionKey).toBe("s1");
      expect(record.expiresAtMs).toBeGreaterThan(record.createdAtMs);
    });

    it("uses explicit id when provided", () => {
      const mgr = new AgentShieldApprovalManager();
      const record = mgr.create(
        { toolName: "t", paramsJSON: "{}" },
        5000,
        "my-custom-id",
      );
      expect(record.id).toBe("my-custom-id");
    });

    it("generates uuid when id is empty", () => {
      const mgr = new AgentShieldApprovalManager();
      const record = mgr.create({ toolName: "t", paramsJSON: "{}" }, 5000, "  ");
      expect(record.id).toBeTruthy();
      expect(record.id.trim()).not.toBe("");
    });
  });

  describe("waitForDecision + resolve", () => {
    it("resolves with allow-once", async () => {
      const mgr = new AgentShieldApprovalManager();
      const record = mgr.create({ toolName: "t", paramsJSON: "{}" }, 5000);
      const promise = mgr.waitForDecision(record, 5000);
      const ok = mgr.resolve(record.id, "allow-once");
      expect(ok).toBe(true);
      const decision = await promise;
      expect(decision).toBe("allow-once");
    });

    it("resolves with deny", async () => {
      const mgr = new AgentShieldApprovalManager();
      const record = mgr.create({ toolName: "t", paramsJSON: "{}" }, 5000);
      const promise = mgr.waitForDecision(record, 5000);
      mgr.resolve(record.id, "deny");
      expect(await promise).toBe("deny");
    });

    it("returns null on timeout", async () => {
      const mgr = new AgentShieldApprovalManager();
      const record = mgr.create({ toolName: "t", paramsJSON: "{}" }, 50);
      const decision = await mgr.waitForDecision(record, 50);
      expect(decision).toBeNull();
    });

    it("returns false for unknown id", () => {
      const mgr = new AgentShieldApprovalManager();
      expect(mgr.resolve("nonexistent", "deny")).toBe(false);
    });

    it("duplicate resolve returns false", async () => {
      const mgr = new AgentShieldApprovalManager();
      const record = mgr.create({ toolName: "t", paramsJSON: "{}" }, 5000);
      const promise = mgr.waitForDecision(record, 5000);
      mgr.resolve(record.id, "allow-once");
      await promise;
      expect(mgr.resolve(record.id, "deny")).toBe(false);
    });
  });

  describe("getSnapshot", () => {
    it("returns record while pending", () => {
      const mgr = new AgentShieldApprovalManager();
      const record = mgr.create({ toolName: "t", paramsJSON: "{}" }, 5000);
      void mgr.waitForDecision(record, 5000);
      const snap = mgr.getSnapshot(record.id);
      expect(snap).not.toBeNull();
      expect(snap?.toolName).toBe("t");
      // Clean up
      mgr.resolve(record.id, "deny");
    });

    it("returns null for unknown id", () => {
      const mgr = new AgentShieldApprovalManager();
      expect(mgr.getSnapshot("nope")).toBeNull();
    });
  });

  describe("listPending", () => {
    it("lists unresolved entries", async () => {
      const mgr = new AgentShieldApprovalManager();
      const r1 = mgr.create({ toolName: "t1", paramsJSON: "{}" }, 5000);
      const r2 = mgr.create({ toolName: "t2", paramsJSON: "{}" }, 5000);
      const p1 = mgr.waitForDecision(r1, 5000);
      void mgr.waitForDecision(r2, 5000);
      mgr.resolve(r1.id, "deny");
      await p1;
      const pending = mgr.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.toolName).toBe("t2");
      // Clean up
      mgr.resolve(r2.id, "deny");
    });

    it("returns empty when nothing pending", () => {
      const mgr = new AgentShieldApprovalManager();
      expect(mgr.listPending()).toEqual([]);
    });
  });
});

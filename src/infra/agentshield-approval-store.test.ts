import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentShieldApprovalStore } from "./agentshield-approval-store.js";

describe("AgentShieldApprovalStore", () => {
  let tempDir: string;
  let store: AgentShieldApprovalStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshield-store-test-"));
    store = new AgentShieldApprovalStore(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("storeRequest", () => {
    it("stores a request to disk", () => {
      const record = {
        id: "test-123",
        toolName: "file_write",
        argsFingerprint: "abc123def456",
        agentId: "test-agent",
        sessionKey: "session-1",
        createdAt: "2025-01-01T00:00:00Z",
        expiresAt: "2025-01-01T00:02:00Z",
        status: "pending" as const,
      };

      store.storeRequest(record);

      const filepath = path.join(tempDir, "agentshield", "approvals", "requests", "test-123.json");
      expect(fs.existsSync(filepath)).toBe(true);

      const loaded = JSON.parse(fs.readFileSync(filepath, "utf8"));
      expect(loaded.id).toBe("test-123");
      expect(loaded.toolName).toBe("file_write");
    });
  });

  describe("loadRequest", () => {
    it("loads a stored request", () => {
      const record = {
        id: "test-456",
        toolName: "http_get",
        argsFingerprint: "xyz789",
        agentId: "agent-2",
        sessionKey: "session-2",
        createdAt: "2025-01-01T00:00:00Z",
        expiresAt: "2025-01-01T00:02:00Z",
        status: "pending" as const,
      };

      store.storeRequest(record);
      const loaded = store.loadRequest("test-456");

      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe("test-456");
      expect(loaded?.toolName).toBe("http_get");
    });

    it("returns null for non-existent request", () => {
      const loaded = store.loadRequest("non-existent");
      expect(loaded).toBeNull();
    });
  });

  describe("updateRequestStatus", () => {
    it("updates the status of a request", () => {
      const record = {
        id: "test-789",
        toolName: "shell_exec",
        argsFingerprint: "fingerprint-1",
        agentId: "agent-3",
        sessionKey: "session-3",
        createdAt: "2025-01-01T00:00:00Z",
        expiresAt: "2025-01-01T00:02:00Z",
        status: "pending" as const,
      };

      store.storeRequest(record);
      const updated = store.updateRequestStatus("test-789", "approved");

      expect(updated).toBe(true);

      const loaded = store.loadRequest("test-789");
      expect(loaded?.status).toBe("approved");
    });

    it("returns false for non-existent request", () => {
      const updated = store.updateRequestStatus("non-existent", "approved");
      expect(updated).toBe(false);
    });
  });

  describe("storeDecision", () => {
    it("stores a decision and updates request status", () => {
      const request = {
        id: "test-decision-1",
        toolName: "file_read",
        argsFingerprint: "fp-1",
        agentId: "agent-4",
        sessionKey: "session-4",
        createdAt: "2025-01-01T00:00:00Z",
        expiresAt: "2025-01-01T00:02:00Z",
        status: "pending" as const,
      };

      store.storeRequest(request);

      const decision = {
        id: "test-decision-1",
        decision: "allow-once" as const,
        reason: "Approved by operator",
        resolvedBy: "admin",
        resolvedAt: "2025-01-01T00:01:00Z",
      };

      store.storeDecision(decision);

      const loadedDecision = store.loadDecision("test-decision-1");
      expect(loadedDecision).not.toBeNull();
      expect(loadedDecision?.decision).toBe("allow-once");
      expect(loadedDecision?.reason).toBe("Approved by operator");

      const loadedRequest = store.loadRequest("test-decision-1");
      expect(loadedRequest?.status).toBe("approved");
    });

    it("sets status to denied for deny decision", () => {
      const request = {
        id: "test-deny-1",
        toolName: "shell_exec",
        argsFingerprint: "fp-deny",
        agentId: "agent-5",
        sessionKey: "session-5",
        createdAt: "2025-01-01T00:00:00Z",
        expiresAt: "2025-01-01T00:02:00Z",
        status: "pending" as const,
      };

      store.storeRequest(request);

      const decision = {
        id: "test-deny-1",
        decision: "deny" as const,
        resolvedAt: "2025-01-01T00:01:00Z",
      };

      store.storeDecision(decision);

      const loadedRequest = store.loadRequest("test-deny-1");
      expect(loadedRequest?.status).toBe("denied");
    });
  });

  describe("listRequests", () => {
    it("lists all requests", () => {
      store.storeRequest({
        id: "list-1",
        toolName: "tool-1",
        argsFingerprint: "fp-1",
        agentId: "agent",
        sessionKey: "session",
        createdAt: "2025-01-01T00:00:00Z",
        expiresAt: "2025-01-01T00:02:00Z",
        status: "pending",
      });

      store.storeRequest({
        id: "list-2",
        toolName: "tool-2",
        argsFingerprint: "fp-2",
        agentId: "agent",
        sessionKey: "session",
        createdAt: "2025-01-01T00:01:00Z",
        expiresAt: "2025-01-01T00:03:00Z",
        status: "approved",
      });

      const all = store.listRequests();
      expect(all.length).toBe(2);
    });

    it("filters by status", () => {
      // Use future dates so pending doesn't get marked as expired
      const futureDate = new Date(Date.now() + 60000).toISOString();

      store.storeRequest({
        id: "filter-1",
        toolName: "tool-1",
        argsFingerprint: "fp-1",
        agentId: "agent",
        sessionKey: "session",
        createdAt: new Date().toISOString(),
        expiresAt: futureDate,
        status: "pending",
      });

      store.storeRequest({
        id: "filter-2",
        toolName: "tool-2",
        argsFingerprint: "fp-2",
        agentId: "agent",
        sessionKey: "session",
        createdAt: new Date().toISOString(),
        expiresAt: futureDate,
        status: "approved",
      });

      const pending = store.listRequests({ status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0]?.id).toBe("filter-1");

      const approved = store.listRequests({ status: "approved" });
      expect(approved.length).toBe(1);
      expect(approved[0]?.id).toBe("filter-2");
    });

    it("respects limit", () => {
      const futureDate = new Date(Date.now() + 60000).toISOString();
      for (let i = 0; i < 5; i++) {
        store.storeRequest({
          id: `limit-${i}`,
          toolName: "tool",
          argsFingerprint: `fp-${i}`,
          agentId: "agent",
          sessionKey: "session",
          createdAt: new Date(Date.now() + i * 1000).toISOString(),
          expiresAt: futureDate,
          status: "pending",
        });
      }

      const limited = store.listRequests({ limit: 3 });
      expect(limited.length).toBe(3);
    });

    it("sorts by createdAt descending", () => {
      store.storeRequest({
        id: "sort-1",
        toolName: "tool",
        argsFingerprint: "fp-1",
        agentId: "agent",
        sessionKey: "session",
        createdAt: "2025-01-01T00:00:00Z",
        expiresAt: "2025-01-01T00:02:00Z",
        status: "pending",
      });

      store.storeRequest({
        id: "sort-2",
        toolName: "tool",
        argsFingerprint: "fp-2",
        agentId: "agent",
        sessionKey: "session",
        createdAt: "2025-01-01T00:05:00Z",
        expiresAt: "2025-01-01T00:07:00Z",
        status: "pending",
      });

      const all = store.listRequests();
      expect(all[0]?.id).toBe("sort-2"); // Newer first
      expect(all[1]?.id).toBe("sort-1");
    });
  });

  describe("remove", () => {
    it("removes request and decision", () => {
      store.storeRequest({
        id: "remove-1",
        toolName: "tool",
        argsFingerprint: "fp",
        agentId: "agent",
        sessionKey: "session",
        createdAt: "2025-01-01T00:00:00Z",
        expiresAt: "2025-01-01T00:02:00Z",
        status: "pending",
      });

      store.storeDecision({
        id: "remove-1",
        decision: "allow-once",
        resolvedAt: "2025-01-01T00:01:00Z",
      });

      const removed = store.remove("remove-1");
      expect(removed).toBe(true);

      expect(store.loadRequest("remove-1")).toBeNull();
      expect(store.loadDecision("remove-1")).toBeNull();
    });

    it("returns false for non-existent id", () => {
      const removed = store.remove("non-existent");
      expect(removed).toBe(false);
    });
  });
});

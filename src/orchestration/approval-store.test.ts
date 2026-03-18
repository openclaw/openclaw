/**
 * Tests for approval-store-sqlite.ts + activity-log-sqlite.ts (Phase 5.13)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

type TestDb = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
let testDb: TestDb;

vi.mock("../infra/state-db/index.js", () => ({
  getStateDb: () => testDb,
}));

vi.mock("../infra/state-db/connection.js", () => ({
  getStateDb: () => testDb,
}));

import { logActivity, listActivityLogs } from "./activity-log-sqlite.js";
import {
  requestApproval,
  getApproval,
  listApprovals,
  decideApproval,
} from "./approval-store-sqlite.js";
import { createWorkspace } from "./workspace-store-sqlite.js";

function makeWorkspace() {
  return createWorkspace({ name: "Approval WS", brandColor: "#8b5cf6" });
}

describe("approval-store-sqlite", () => {
  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    testDb = new DatabaseSync(":memory:");
    testDb.exec("PRAGMA journal_mode = WAL");
    testDb.exec("PRAGMA foreign_keys = ON");
    runMigrations(testDb);
  });

  afterEach(() => {
    try {
      testDb.close();
    } catch {
      // ignore
    }
  });

  // ── Approvals CRUD ────────────────────────────────────────────────

  describe("approvals", () => {
    it("requestApproval creates a pending approval", () => {
      const ws = makeWorkspace();
      const approval = requestApproval({
        workspaceId: ws.id,
        type: "agent_hire",
        requesterId: "agent-1",
        requesterType: "agent",
      });

      expect(approval.status).toBe("pending");
      expect(approval.type).toBe("agent_hire");
      expect(approval.requesterId).toBe("agent-1");
      expect(approval.decidedBy).toBeNull();
    });

    it("getApproval returns null for unknown id", () => {
      expect(getApproval("nonexistent")).toBeNull();
    });

    it("listApprovals returns approvals for a workspace", () => {
      const ws = makeWorkspace();
      requestApproval({
        workspaceId: ws.id,
        type: "config_change",
        requesterId: "agent-2",
      });
      requestApproval({
        workspaceId: ws.id,
        type: "budget_override",
        requesterId: "agent-3",
      });

      const approvals = listApprovals({ workspaceId: ws.id });
      expect(approvals).toHaveLength(2);
    });

    it("listApprovals filters by status", () => {
      const ws = makeWorkspace();
      const a1 = requestApproval({
        workspaceId: ws.id,
        type: "agent_hire",
        requesterId: "agent-1",
      });
      requestApproval({
        workspaceId: ws.id,
        type: "config_change",
        requesterId: "agent-2",
      });
      decideApproval(a1.id, "approved", "user-admin");

      const pending = listApprovals({ workspaceId: ws.id, status: "pending" });
      expect(pending).toHaveLength(1);
      expect(pending[0].type).toBe("config_change");
    });

    it("listApprovals stores and returns payload", () => {
      const ws = makeWorkspace();
      const approval = requestApproval({
        workspaceId: ws.id,
        type: "config_change",
        requesterId: "agent-1",
        payload: { key: "model", newValue: "claude-opus-4-6" },
      });

      expect(approval.payloadJson).toBeTruthy();
      const parsed = JSON.parse(approval.payloadJson!);
      expect(parsed.key).toBe("model");
    });
  });

  // ── Approval decisions ────────────────────────────────────────────

  describe("approval decisions", () => {
    it("decideApproval approves a pending approval", () => {
      const ws = makeWorkspace();
      const approval = requestApproval({
        workspaceId: ws.id,
        type: "agent_hire",
        requesterId: "agent-1",
      });

      const decided = decideApproval(approval.id, "approved", "user-admin", "Looks good");
      expect(decided.status).toBe("approved");
      expect(decided.decidedBy).toBe("user-admin");
      expect(decided.decisionNote).toBe("Looks good");
      expect(decided.decidedAt).toBeGreaterThan(0);
    });

    it("decideApproval rejects a pending approval", () => {
      const ws = makeWorkspace();
      const approval = requestApproval({
        workspaceId: ws.id,
        type: "budget_override",
        requesterId: "agent-2",
      });

      const decided = decideApproval(approval.id, "rejected", "user-admin", "Over budget");
      expect(decided.status).toBe("rejected");
    });

    it("decideApproval requests revision", () => {
      const ws = makeWorkspace();
      const approval = requestApproval({
        workspaceId: ws.id,
        type: "config_change",
        requesterId: "agent-1",
      });

      const revised = decideApproval(
        approval.id,
        "revision_requested",
        "user-admin",
        "Need more details",
      );
      expect(revised.status).toBe("revision_requested");
    });

    it("decideApproval throws for unknown approval", () => {
      expect(() => decideApproval("nonexistent", "approved", "admin")).toThrow(
        "Approval not found",
      );
    });

    it("decideApproval throws when approval is already approved", () => {
      const ws = makeWorkspace();
      const approval = requestApproval({
        workspaceId: ws.id,
        type: "agent_hire",
        requesterId: "agent-1",
      });
      decideApproval(approval.id, "approved", "admin");

      expect(() => decideApproval(approval.id, "rejected", "admin")).toThrow(
        "Cannot decide on approval",
      );
    });
  });
});

// ── Activity log ──────────────────────────────────────────────────────

describe("activity-log-sqlite", () => {
  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    testDb = new DatabaseSync(":memory:");
    testDb.exec("PRAGMA journal_mode = WAL");
    testDb.exec("PRAGMA foreign_keys = ON");
    runMigrations(testDb);
  });

  afterEach(() => {
    try {
      testDb.close();
    } catch {
      // ignore
    }
  });

  it("logActivity records an action with numeric id", () => {
    const ws = createWorkspace({ name: "Log WS", brandColor: "#000" });
    const entry = logActivity({
      workspaceId: ws.id,
      actorType: "user",
      actorId: "user-1",
      action: "task.created",
      entityType: "task",
      entityId: "task-abc",
    });

    expect(typeof entry.id).toBe("number");
    expect(entry.action).toBe("task.created");
    expect(entry.actorId).toBe("user-1");
    expect(entry.entityType).toBe("task");
  });

  it("logActivity stores details as JSON", () => {
    const ws = createWorkspace({ name: "Log WS 2", brandColor: "#000" });
    const entry = logActivity({
      workspaceId: ws.id,
      action: "goal.updated",
      details: { field: "status", oldValue: "planned", newValue: "in_progress" },
    });

    const parsed = JSON.parse(entry.detailsJson!);
    expect(parsed.field).toBe("status");
  });

  it("listActivityLogs returns entries for a workspace in descending order", () => {
    const ws = createWorkspace({ name: "Log Order WS", brandColor: "#000" });
    logActivity({ workspaceId: ws.id, action: "action.first" });
    logActivity({ workspaceId: ws.id, action: "action.second" });

    const logs = listActivityLogs({ workspaceId: ws.id });
    expect(logs).toHaveLength(2);
    // Most recent first
    expect(logs[0].action).toBe("action.second");
    expect(logs[1].action).toBe("action.first");
  });

  it("listActivityLogs filters by entityType", () => {
    const ws = createWorkspace({ name: "Log Filter WS", brandColor: "#000" });
    logActivity({ workspaceId: ws.id, action: "task.created", entityType: "task" });
    logActivity({ workspaceId: ws.id, action: "goal.created", entityType: "goal" });

    const taskLogs = listActivityLogs({ workspaceId: ws.id, entityType: "task" });
    expect(taskLogs).toHaveLength(1);
    expect(taskLogs[0].action).toBe("task.created");
  });

  it("listActivityLogs respects limit", () => {
    const ws = createWorkspace({ name: "Log Limit WS", brandColor: "#000" });
    for (let i = 0; i < 5; i++) {
      logActivity({ workspaceId: ws.id, action: `action.${i}` });
    }

    const limited = listActivityLogs({ workspaceId: ws.id, limit: 3 });
    expect(limited).toHaveLength(3);
  });
});

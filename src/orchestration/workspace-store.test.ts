/**
 * Tests for workspace-store-sqlite.ts + agent-metrics-sqlite.ts (Phase 6.14)
 *
 * Covers:
 * - Workspace CRUD and agent assignment
 * - resolveAgentWorkspace attribution
 * - Agent performance metrics computation
 * - Per-workspace metrics aggregation
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

type TestDb = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
let testDb: TestDb;

vi.mock("../infra/state-db/connection.js", () => ({
  getStateDb: () => testDb,
}));

vi.mock("../infra/state-db/index.js", () => ({
  getStateDb: () => testDb,
}));

import { getAgentMetrics, listAgentMetricsForWorkspace } from "./agent-metrics-sqlite.js";
import { recordCostEvent } from "./cost-event-store-sqlite.js";
import { createTask, updateTask } from "./task-store-sqlite.js";
import {
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  archiveWorkspace,
  assignAgentToWorkspace,
  removeAgentFromWorkspace,
  listWorkspaceAgents,
  updateWorkspaceAgentStatus,
  resolveAgentWorkspace,
} from "./workspace-store-sqlite.js";

describe("workspace-store-sqlite", () => {
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

  // ── Workspace CRUD ────────────────────────────────────────────────

  describe("workspace CRUD", () => {
    it("createWorkspace stores name and default values", () => {
      const ws = createWorkspace({ name: "Engineering" });

      expect(ws.name).toBe("Engineering");
      expect(ws.status).toBe("active");
      expect(ws.taskPrefix).toBe("OP1");
      expect(ws.taskCounter).toBe(0);
      expect(ws.brandColor).toBeNull();
    });

    it("createWorkspace stores custom taskPrefix and brandColor", () => {
      const ws = createWorkspace({
        name: "Product",
        taskPrefix: "PROD",
        brandColor: "#f59e0b",
      });

      expect(ws.taskPrefix).toBe("PROD");
      expect(ws.brandColor).toBe("#f59e0b");
    });

    it("getWorkspace returns undefined for unknown id", () => {
      expect(getWorkspace("nonexistent")).toBeUndefined();
    });

    it("listWorkspaces returns all workspaces (including default seeded by migrations)", () => {
      const before = listWorkspaces().length;
      createWorkspace({ name: "WS1" });
      createWorkspace({ name: "WS2" });
      expect(listWorkspaces()).toHaveLength(before + 2);
    });

    it("updateWorkspace changes name and description", () => {
      const ws = createWorkspace({ name: "Old Name" });
      const updated = updateWorkspace(ws.id, { name: "New Name", description: "Details" });

      expect(updated.name).toBe("New Name");
      expect(updated.description).toBe("Details");
    });

    it("archiveWorkspace sets status to archived", () => {
      const ws = createWorkspace({ name: "To Archive" });
      const archived = archiveWorkspace(ws.id);
      expect(archived.status).toBe("archived");
    });
  });

  // ── Agent assignment ──────────────────────────────────────────────

  describe("agent assignment", () => {
    it("assignAgentToWorkspace creates an assignment", () => {
      const ws = createWorkspace({ name: "Assignment WS" });
      assignAgentToWorkspace(ws.id, "agent-1", "developer");

      const agents = listWorkspaceAgents(ws.id);
      expect(agents).toHaveLength(1);
      expect(agents[0].agentId).toBe("agent-1");
      expect(agents[0].role).toBe("developer");
    });

    it("assignAgentToWorkspace is idempotent (upsert)", () => {
      const ws = createWorkspace({ name: "Upsert WS" });
      assignAgentToWorkspace(ws.id, "agent-1", "developer");
      assignAgentToWorkspace(ws.id, "agent-1", "lead"); // should not throw

      const agents = listWorkspaceAgents(ws.id);
      expect(agents).toHaveLength(1);
      expect(agents[0].role).toBe("lead");
    });

    it("removeAgentFromWorkspace removes the assignment", () => {
      const ws = createWorkspace({ name: "Remove WS" });
      assignAgentToWorkspace(ws.id, "agent-1");
      removeAgentFromWorkspace(ws.id, "agent-1");

      expect(listWorkspaceAgents(ws.id)).toHaveLength(0);
    });

    it("updateWorkspaceAgentStatus changes status and capabilities", () => {
      const ws = createWorkspace({ name: "Status WS" });
      assignAgentToWorkspace(ws.id, "agent-1");
      updateWorkspaceAgentStatus(ws.id, "agent-1", "inactive", ["code", "review"]);

      const agents = listWorkspaceAgents(ws.id);
      expect(agents[0].status).toBe("inactive");
      expect(agents[0].capabilities).toEqual(["code", "review"]);
    });
  });

  // ── resolveAgentWorkspace ─────────────────────────────────────────

  describe("resolveAgentWorkspace", () => {
    it("returns the workspace an agent is assigned to", () => {
      const ws = createWorkspace({ name: "Agent WS" });
      assignAgentToWorkspace(ws.id, "agent-abc");

      const resolved = resolveAgentWorkspace("agent-abc");
      expect(resolved).toBeDefined();
      expect(resolved?.id).toBe(ws.id);
    });

    it("falls back to default workspace for an unassigned agent", () => {
      // resolveAgentWorkspace falls back to the first workspace in the DB
      // (the "default" workspace seeded by migrations)
      const result = resolveAgentWorkspace("unknown-agent");
      expect(result).toBeDefined();
      expect(result?.id).toBe("default");
    });

    it("returns the oldest workspace when agent is in multiple", () => {
      const ws1 = createWorkspace({ name: "WS First" });
      const ws2 = createWorkspace({ name: "WS Second" });
      assignAgentToWorkspace(ws1.id, "multi-agent");
      assignAgentToWorkspace(ws2.id, "multi-agent");

      const resolved = resolveAgentWorkspace("multi-agent");
      // Should be ws1 (oldest join)
      expect(resolved?.id).toBe(ws1.id);
    });
  });
});

// ── Agent metrics ─────────────────────────────────────────────────────────────

describe("agent-metrics-sqlite", () => {
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

  it("getAgentMetrics returns zeros for an agent with no data", () => {
    const ws = createWorkspace({ name: "Empty Metrics WS" });
    const metrics = getAgentMetrics(ws.id, "agent-unknown");

    expect(metrics.totalCostMicrocents).toBe(0);
    expect(metrics.totalInputTokens).toBe(0);
    expect(metrics.tasksCompleted).toBe(0);
    expect(metrics.tasksInProgress).toBe(0);
  });

  it("getAgentMetrics aggregates cost events for an agent", () => {
    const ws = createWorkspace({ name: "Cost Metrics WS" });
    recordCostEvent({
      workspaceId: ws.id,
      agentId: "agent-x",
      inputTokens: 100,
      outputTokens: 50,
      costMicrocents: 5_000,
    });
    recordCostEvent({
      workspaceId: ws.id,
      agentId: "agent-x",
      inputTokens: 200,
      outputTokens: 100,
      costMicrocents: 10_000,
    });

    const metrics = getAgentMetrics(ws.id, "agent-x");
    expect(metrics.totalCostMicrocents).toBe(15_000);
    expect(metrics.totalInputTokens).toBe(300);
    expect(metrics.totalOutputTokens).toBe(150);
  });

  it("getAgentMetrics counts completed and in-progress tasks", () => {
    const ws = createWorkspace({ name: "Task Metrics WS", taskPrefix: "TM" });

    // Create 2 done tasks and 1 in-progress
    const t1 = createTask({ workspaceId: ws.id, title: "Done 1", assigneeAgentId: "agent-y" });
    const t2 = createTask({ workspaceId: ws.id, title: "Done 2", assigneeAgentId: "agent-y" });
    const t3 = createTask({
      workspaceId: ws.id,
      title: "In progress",
      assigneeAgentId: "agent-y",
    });

    updateTask(t1.id, { status: "todo" });
    updateTask(t1.id, { status: "in_progress" });
    updateTask(t1.id, { status: "done" });

    updateTask(t2.id, { status: "todo" });
    updateTask(t2.id, { status: "in_progress" });
    updateTask(t2.id, { status: "done" });

    updateTask(t3.id, { status: "todo" });
    updateTask(t3.id, { status: "in_progress" });

    const metrics = getAgentMetrics(ws.id, "agent-y");
    expect(metrics.tasksCompleted).toBe(2);
    expect(metrics.tasksInProgress).toBe(1);
  });

  it("listAgentMetricsForWorkspace returns one entry per agent", () => {
    const ws = createWorkspace({ name: "Multi Agent Metrics WS" });
    recordCostEvent({
      workspaceId: ws.id,
      agentId: "agent-a",
      inputTokens: 50,
      outputTokens: 25,
      costMicrocents: 3_000,
    });
    recordCostEvent({
      workspaceId: ws.id,
      agentId: "agent-b",
      inputTokens: 80,
      outputTokens: 40,
      costMicrocents: 7_000,
    });

    const all = listAgentMetricsForWorkspace(ws.id);
    expect(all).toHaveLength(2);
    const agentIds = all.map((m) => m.agentId).toSorted();
    expect(agentIds).toEqual(["agent-a", "agent-b"]);
  });

  it("listAgentMetricsForWorkspace does not include other workspace data", () => {
    const ws1 = createWorkspace({ name: "WS1" });
    const ws2 = createWorkspace({ name: "WS2" });

    recordCostEvent({
      workspaceId: ws1.id,
      agentId: "agent-1",
      inputTokens: 10,
      outputTokens: 5,
      costMicrocents: 1_000,
    });
    recordCostEvent({
      workspaceId: ws2.id,
      agentId: "agent-2",
      inputTokens: 20,
      outputTokens: 10,
      costMicrocents: 2_000,
    });

    const ws1Metrics = listAgentMetricsForWorkspace(ws1.id);
    expect(ws1Metrics).toHaveLength(1);
    expect(ws1Metrics[0].agentId).toBe("agent-1");
  });
});

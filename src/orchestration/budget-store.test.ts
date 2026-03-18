/**
 * Tests for budget-store-sqlite.ts + cost-event-store-sqlite.ts + budget-cron.ts (Phase 4.12)
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

import { reconcileBudgets } from "./budget-cron.js";
import {
  createBudgetPolicy,
  listBudgetPolicies,
  getBudgetPolicy,
  updateBudgetPolicy,
  deleteBudgetPolicy,
  listBudgetIncidents,
  createBudgetIncident,
  resolveBudgetIncident,
} from "./budget-store-sqlite.js";
import { recordCostEvent, getAggregateCost } from "./cost-event-store-sqlite.js";
import { createWorkspace } from "./workspace-store-sqlite.js";

function makeWorkspace() {
  return createWorkspace({ name: "Budget WS", brandColor: "#f59e0b" });
}

describe("budget-store-sqlite", () => {
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

  // ── Budget policies ───────────────────────────────────────────────

  describe("budget policies", () => {
    it("createBudgetPolicy stores all fields with defaults", () => {
      const ws = makeWorkspace();
      const policy = createBudgetPolicy({
        workspaceId: ws.id,
        scopeType: "workspace",
        scopeId: ws.id,
        amountMicrocents: 1_000_000_000, // $10
      });

      expect(policy.scopeType).toBe("workspace");
      expect(policy.amountMicrocents).toBe(1_000_000_000);
      expect(policy.windowKind).toBe("calendar_month_utc");
      expect(policy.warnPercent).toBe(80);
      expect(policy.hardStop).toBe(0); // default: no hard stop
    });

    it("getBudgetPolicy returns null for unknown id", () => {
      expect(getBudgetPolicy("nonexistent")).toBeNull();
    });

    it("listBudgetPolicies returns policies for a workspace", () => {
      const ws = makeWorkspace();
      createBudgetPolicy({
        workspaceId: ws.id,
        scopeType: "workspace",
        scopeId: ws.id,
        amountMicrocents: 500_000_000,
      });
      const policies = listBudgetPolicies({ workspaceId: ws.id });
      expect(policies).toHaveLength(1);
    });

    it("updateBudgetPolicy changes amount", () => {
      const ws = makeWorkspace();
      const policy = createBudgetPolicy({
        workspaceId: ws.id,
        scopeType: "workspace",
        scopeId: ws.id,
        amountMicrocents: 500_000_000,
      });
      const updated = updateBudgetPolicy(policy.id, { amountMicrocents: 2_000_000_000 });
      expect(updated.amountMicrocents).toBe(2_000_000_000);
    });

    it("deleteBudgetPolicy removes the policy", () => {
      const ws = makeWorkspace();
      const policy = createBudgetPolicy({
        workspaceId: ws.id,
        scopeType: "workspace",
        scopeId: ws.id,
        amountMicrocents: 100_000_000,
      });
      deleteBudgetPolicy(policy.id);
      expect(getBudgetPolicy(policy.id)).toBeNull();
    });
  });

  // ── Cost events ───────────────────────────────────────────────────

  describe("cost events", () => {
    it("recordCostEvent stores cost and tokens", () => {
      const ws = makeWorkspace();
      const event = recordCostEvent({
        workspaceId: ws.id,
        agentId: "agent-1",
        inputTokens: 100,
        outputTokens: 50,
        costMicrocents: 15_000,
      });

      expect(event.workspaceId).toBe(ws.id);
      expect(event.agentId).toBe("agent-1");
      expect(event.inputTokens).toBe(100);
      expect(event.outputTokens).toBe(50);
      expect(event.costMicrocents).toBe(15_000);
    });

    it("getAggregateCost sums all events for a workspace", () => {
      const ws = makeWorkspace();
      recordCostEvent({
        workspaceId: ws.id,
        agentId: "a1",
        inputTokens: 100,
        outputTokens: 50,
        costMicrocents: 10_000,
      });
      recordCostEvent({
        workspaceId: ws.id,
        agentId: "a2",
        inputTokens: 200,
        outputTokens: 100,
        costMicrocents: 20_000,
      });

      const agg = getAggregateCost({ workspaceId: ws.id });
      expect(agg.totalMicrocents).toBe(30_000);
      expect(agg.totalInputTokens).toBe(300);
      expect(agg.totalOutputTokens).toBe(150);
    });

    it("getAggregateCost returns zeros for empty workspace", () => {
      const ws = makeWorkspace();
      const agg = getAggregateCost({ workspaceId: ws.id });
      expect(agg.totalMicrocents).toBe(0);
    });

    it("getAggregateCost filters by agentId", () => {
      const ws = makeWorkspace();
      recordCostEvent({
        workspaceId: ws.id,
        agentId: "agent-x",
        inputTokens: 50,
        outputTokens: 25,
        costMicrocents: 5_000,
      });
      recordCostEvent({
        workspaceId: ws.id,
        agentId: "agent-y",
        inputTokens: 100,
        outputTokens: 50,
        costMicrocents: 10_000,
      });

      const agg = getAggregateCost({ workspaceId: ws.id, agentId: "agent-x" });
      expect(agg.totalMicrocents).toBe(5_000);
    });
  });

  // ── Budget incidents ──────────────────────────────────────────────

  describe("budget incidents", () => {
    it("createBudgetIncident creates a warning incident", () => {
      const ws = makeWorkspace();
      const policy = createBudgetPolicy({
        workspaceId: ws.id,
        scopeType: "workspace",
        scopeId: ws.id,
        amountMicrocents: 1_000_000,
      });

      const incident = createBudgetIncident({
        workspaceId: ws.id,
        policyId: policy.id,
        type: "warning",
        spentMicrocents: 820_000,
        limitMicrocents: 1_000_000,
        message: "Warning threshold reached",
      });

      expect(incident.type).toBe("warning");
      expect(incident.spentMicrocents).toBe(820_000);
      expect(incident.resolvedAt).toBeNull();
    });

    it("listBudgetIncidents returns incidents for a workspace", () => {
      const ws = makeWorkspace();
      const policy = createBudgetPolicy({
        workspaceId: ws.id,
        scopeType: "workspace",
        scopeId: ws.id,
        amountMicrocents: 1_000_000,
      });
      createBudgetIncident({
        workspaceId: ws.id,
        policyId: policy.id,
        type: "warning",
        spentMicrocents: 800_000,
        limitMicrocents: 1_000_000,
      });

      const incidents = listBudgetIncidents({ workspaceId: ws.id });
      expect(incidents).toHaveLength(1);
    });

    it("resolveBudgetIncident marks incident as resolved", () => {
      const ws = makeWorkspace();
      const policy = createBudgetPolicy({
        workspaceId: ws.id,
        scopeType: "workspace",
        scopeId: ws.id,
        amountMicrocents: 1_000_000,
      });
      const incident = createBudgetIncident({
        workspaceId: ws.id,
        policyId: policy.id,
        type: "hard_stop",
        spentMicrocents: 1_000_000,
        limitMicrocents: 1_000_000,
      });

      const resolved = resolveBudgetIncident(incident.id);
      expect(resolved.type).toBe("resolved");
      expect(resolved.resolvedAt).toBeGreaterThan(0);
    });
  });

  // ── Reconciliation ────────────────────────────────────────────────

  describe("reconcileBudgets", () => {
    it("creates a warning incident when spend exceeds warnPercent", () => {
      const ws = makeWorkspace();
      createBudgetPolicy({
        workspaceId: ws.id,
        scopeType: "workspace",
        scopeId: ws.id,
        amountMicrocents: 1_000_000,
        warnPercent: 80,
        hardStop: 100,
      });
      // Spend 85% of budget
      recordCostEvent({
        workspaceId: ws.id,
        agentId: "agent-1",
        inputTokens: 100,
        outputTokens: 50,
        costMicrocents: 850_000,
      });

      reconcileBudgets();

      const incidents = listBudgetIncidents({ workspaceId: ws.id });
      expect(incidents.length).toBeGreaterThanOrEqual(1);
      const warning = incidents.find((i) => i.type === "warning");
      expect(warning).toBeDefined();
    });

    it("creates a hard_stop incident when spend exceeds hardStop", () => {
      const ws = makeWorkspace();
      createBudgetPolicy({
        workspaceId: ws.id,
        scopeType: "workspace",
        scopeId: ws.id,
        amountMicrocents: 1_000_000,
        warnPercent: 80,
        hardStop: 100,
      });
      // Spend 100% of budget
      recordCostEvent({
        workspaceId: ws.id,
        agentId: "agent-1",
        inputTokens: 100,
        outputTokens: 50,
        costMicrocents: 1_000_000,
      });

      reconcileBudgets();

      const incidents = listBudgetIncidents({ workspaceId: ws.id });
      const stop = incidents.find((i) => i.type === "hard_stop");
      expect(stop).toBeDefined();
    });

    it("does not create duplicate incidents for the same policy", () => {
      const ws = makeWorkspace();
      createBudgetPolicy({
        workspaceId: ws.id,
        scopeType: "workspace",
        scopeId: ws.id,
        amountMicrocents: 1_000_000,
        warnPercent: 80,
        hardStop: 100,
      });
      recordCostEvent({
        workspaceId: ws.id,
        agentId: "agent-1",
        inputTokens: 100,
        outputTokens: 50,
        costMicrocents: 850_000,
      });

      reconcileBudgets();
      reconcileBudgets(); // run twice

      const incidents = listBudgetIncidents({ workspaceId: ws.id });
      expect(incidents.filter((i) => i.type === "warning")).toHaveLength(1);
    });

    it("emits broadcast events when incidents are created", () => {
      const ws = makeWorkspace();
      createBudgetPolicy({
        workspaceId: ws.id,
        scopeType: "workspace",
        scopeId: ws.id,
        amountMicrocents: 1_000_000,
        warnPercent: 80,
        hardStop: 100,
      });
      recordCostEvent({
        workspaceId: ws.id,
        agentId: "agent-1",
        inputTokens: 100,
        outputTokens: 50,
        costMicrocents: 850_000,
      });

      const broadcast = vi.fn();
      reconcileBudgets(broadcast);

      expect(broadcast).toHaveBeenCalledWith(
        "budget.warning",
        expect.objectContaining({ workspaceId: ws.id }),
      );
    });

    it("does not create incidents when spend is below thresholds", () => {
      const ws = makeWorkspace();
      createBudgetPolicy({
        workspaceId: ws.id,
        scopeType: "workspace",
        scopeId: ws.id,
        amountMicrocents: 1_000_000,
        warnPercent: 80,
        hardStop: 100,
      });
      recordCostEvent({
        workspaceId: ws.id,
        agentId: "agent-1",
        inputTokens: 10,
        outputTokens: 5,
        costMicrocents: 100_000, // 10%
      });

      reconcileBudgets();

      const incidents = listBudgetIncidents({ workspaceId: ws.id });
      expect(incidents).toHaveLength(0);
    });
  });
});

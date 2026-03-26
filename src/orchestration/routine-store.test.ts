/**
 * Tests for routine-store-sqlite.ts (Paperclip sync P6)
 *
 * Uses an in-memory SQLite DB with full migrations applied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

// ── DB mock (must be declared before store imports) ───────────────────

type TestDb = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
let testDb: TestDb;

vi.mock("../infra/state-db/index.js", () => ({
  getStateDb: () => testDb,
}));

// ── Store imports (hoisted after mock) ────────────────────────────────

import {
  createRoutine,
  getRoutine,
  listRoutines,
  listRoutinesWithDetails,
  updateRoutine,
  deleteRoutine,
  createRoutineTrigger,
  getRoutineTrigger,
  listRoutineTriggers,
  updateRoutineTrigger,
  deleteRoutineTrigger,
  createRoutineRun,
  getRoutineRun,
  listRoutineRuns,
  updateRoutineRun,
} from "./routine-store-sqlite.js";

// workspace-store uses connection.js path
vi.mock("../infra/state-db/connection.js", () => ({
  getStateDb: () => testDb,
}));

// ── Fixtures ──────────────────────────────────────────────────────────

const WS_ID = "ws-test-001";
const AGENT_ID = "agent-abc";

function makeRoutine(title = "My Routine") {
  return createRoutine({ workspaceId: WS_ID, title, assigneeAgentId: AGENT_ID });
}

// ── Suite ─────────────────────────────────────────────────────────────

describe("routine-store-sqlite", () => {
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

  // ── Routines CRUD ─────────────────────────────────────────────────

  describe("routines CRUD", () => {
    it("createRoutine stores title, defaults, and assignee", () => {
      const r = makeRoutine();
      expect(r.title).toBe("My Routine");
      expect(r.status).toBe("active");
      expect(r.priority).toBe("medium");
      expect(r.concurrencyPolicy).toBe("coalesce_if_active");
      expect(r.catchUpPolicy).toBe("skip_missed");
      expect(r.assigneeAgentId).toBe(AGENT_ID);
      expect(r.workspaceId).toBe(WS_ID);
    });

    it("getRoutine returns null for unknown id", () => {
      expect(getRoutine("nonexistent")).toBeNull();
    });

    it("getRoutine returns the created routine by id", () => {
      const r = makeRoutine("Fetch me");
      const fetched = getRoutine(r.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe("Fetch me");
    });

    it("listRoutines returns all routines for a workspace", () => {
      makeRoutine("A");
      makeRoutine("B");
      const list = listRoutines(WS_ID);
      expect(list).toHaveLength(2);
    });

    it("listRoutines returns empty array for unknown workspace", () => {
      makeRoutine();
      expect(listRoutines("other-ws")).toHaveLength(0);
    });

    it("updateRoutine changes title and description", () => {
      const r = makeRoutine();
      const updated = updateRoutine(r.id, { title: "Renamed", description: "Details" });
      expect(updated.title).toBe("Renamed");
      expect(updated.description).toBe("Details");
    });

    it("updateRoutine changes status and priority", () => {
      const r = makeRoutine();
      const updated = updateRoutine(r.id, { status: "paused", priority: "high" });
      expect(updated.status).toBe("paused");
      expect(updated.priority).toBe("high");
    });

    it("updateRoutine throws for unknown routine", () => {
      expect(() => updateRoutine("nonexistent", { title: "x" })).toThrow("Routine not found");
    });

    it("deleteRoutine removes the routine", () => {
      const r = makeRoutine();
      deleteRoutine(r.id);
      expect(getRoutine(r.id)).toBeNull();
    });

    it("createRoutine stores optional fields", () => {
      const r = createRoutine({
        workspaceId: WS_ID,
        title: "Optional Fields",
        assigneeAgentId: AGENT_ID,
        description: "A description",
        projectId: "proj-1",
        goalId: "goal-1",
        createdByUserId: "user-1",
        priority: "critical",
        status: "paused",
      });
      expect(r.description).toBe("A description");
      expect(r.projectId).toBe("proj-1");
      expect(r.goalId).toBe("goal-1");
      expect(r.createdByUserId).toBe("user-1");
      expect(r.priority).toBe("critical");
      expect(r.status).toBe("paused");
    });
  });

  // ── listRoutinesWithDetails ───────────────────────────────────────

  describe("listRoutinesWithDetails", () => {
    it("returns routines with empty triggers and null lastRun when no triggers/runs exist", () => {
      makeRoutine("Detail R");
      const items = listRoutinesWithDetails(WS_ID);
      expect(items).toHaveLength(1);
      expect(items[0].triggers).toHaveLength(0);
      expect(items[0].lastRun).toBeNull();
    });

    it("includes triggers and last run when they exist", () => {
      const r = makeRoutine("With Trigger");
      createRoutineTrigger({ workspaceId: WS_ID, routineId: r.id, kind: "cron" });
      createRoutineRun({ workspaceId: WS_ID, routineId: r.id, source: "scheduled" });
      const items = listRoutinesWithDetails(WS_ID);
      expect(items[0].triggers).toHaveLength(1);
      expect(items[0].lastRun).not.toBeNull();
    });
  });

  // ── Routine Triggers CRUD ─────────────────────────────────────────

  describe("routine triggers CRUD", () => {
    it("createRoutineTrigger stores kind and defaults", () => {
      const r = makeRoutine();
      const t = createRoutineTrigger({ workspaceId: WS_ID, routineId: r.id, kind: "cron" });
      expect(t.kind).toBe("cron");
      expect(t.enabled).toBe(true);
      expect(t.routineId).toBe(r.id);
      expect(t.workspaceId).toBe(WS_ID);
    });

    it("createRoutineTrigger stores cron expression", () => {
      const r = makeRoutine();
      const t = createRoutineTrigger({
        workspaceId: WS_ID,
        routineId: r.id,
        kind: "cron",
        cronExpression: "0 9 * * *",
        timezone: "America/New_York",
      });
      expect(t.cronExpression).toBe("0 9 * * *");
      expect(t.timezone).toBe("America/New_York");
    });

    it("createRoutineTrigger with enabled=false stores false", () => {
      const r = makeRoutine();
      const t = createRoutineTrigger({ workspaceId: WS_ID, routineId: r.id, kind: "webhook", enabled: false });
      expect(t.enabled).toBe(false);
    });

    it("getRoutineTrigger returns null for unknown id", () => {
      expect(getRoutineTrigger("nonexistent")).toBeNull();
    });

    it("listRoutineTriggers returns triggers for a routine", () => {
      const r = makeRoutine();
      createRoutineTrigger({ workspaceId: WS_ID, routineId: r.id, kind: "cron" });
      createRoutineTrigger({ workspaceId: WS_ID, routineId: r.id, kind: "webhook" });
      expect(listRoutineTriggers(r.id)).toHaveLength(2);
    });

    it("listRoutineTriggers returns empty for routine with no triggers", () => {
      const r = makeRoutine();
      expect(listRoutineTriggers(r.id)).toHaveLength(0);
    });

    it("updateRoutineTrigger disables a trigger", () => {
      const r = makeRoutine();
      const t = createRoutineTrigger({ workspaceId: WS_ID, routineId: r.id, kind: "cron" });
      const updated = updateRoutineTrigger(t.id, { enabled: false });
      expect(updated.enabled).toBe(false);
    });

    it("updateRoutineTrigger sets lastFiredAt and lastResult", () => {
      const r = makeRoutine();
      const t = createRoutineTrigger({ workspaceId: WS_ID, routineId: r.id, kind: "cron" });
      const firedAt = Math.floor(Date.now() / 1000);
      const updated = updateRoutineTrigger(t.id, { lastFiredAt: firedAt, lastResult: "success" });
      expect(updated.lastFiredAt).toBe(firedAt);
      expect(updated.lastResult).toBe("success");
    });

    it("updateRoutineTrigger throws for unknown trigger", () => {
      expect(() => updateRoutineTrigger("nonexistent", { enabled: false })).toThrow("RoutineTrigger not found");
    });

    it("deleteRoutineTrigger removes the trigger", () => {
      const r = makeRoutine();
      const t = createRoutineTrigger({ workspaceId: WS_ID, routineId: r.id, kind: "cron" });
      deleteRoutineTrigger(t.id);
      expect(getRoutineTrigger(t.id)).toBeNull();
    });
  });

  // ── Routine Runs CRUD ─────────────────────────────────────────────

  describe("routine runs CRUD", () => {
    it("createRoutineRun stores source and defaults to received status", () => {
      const r = makeRoutine();
      const run = createRoutineRun({ workspaceId: WS_ID, routineId: r.id, source: "manual" });
      expect(run.source).toBe("manual");
      expect(run.status).toBe("received");
      expect(run.routineId).toBe(r.id);
      expect(run.workspaceId).toBe(WS_ID);
      expect(run.triggerPayload).toBeNull();
    });

    it("createRoutineRun stores trigger payload as JSON", () => {
      const r = makeRoutine();
      const payload = { eventType: "push", ref: "main" };
      const run = createRoutineRun({
        workspaceId: WS_ID,
        routineId: r.id,
        source: "webhook",
        triggerPayload: payload,
      });
      expect(run.triggerPayload).toEqual(payload);
    });

    it("createRoutineRun stores idempotency key", () => {
      const r = makeRoutine();
      const run = createRoutineRun({
        workspaceId: WS_ID,
        routineId: r.id,
        source: "scheduled",
        idempotencyKey: "idem-abc-123",
      });
      expect(run.idempotencyKey).toBe("idem-abc-123");
    });

    it("getRoutineRun returns null for unknown id", () => {
      expect(getRoutineRun("nonexistent")).toBeNull();
    });

    it("listRoutineRuns returns runs for a routine", () => {
      const r = makeRoutine();
      createRoutineRun({ workspaceId: WS_ID, routineId: r.id, source: "manual" });
      createRoutineRun({ workspaceId: WS_ID, routineId: r.id, source: "scheduled" });
      expect(listRoutineRuns(r.id)).toHaveLength(2);
    });

    it("listRoutineRuns returns empty for routine with no runs", () => {
      const r = makeRoutine();
      expect(listRoutineRuns(r.id)).toHaveLength(0);
    });

    it("listRoutineRuns respects limit option", () => {
      const r = makeRoutine();
      createRoutineRun({ workspaceId: WS_ID, routineId: r.id, source: "s1" });
      createRoutineRun({ workspaceId: WS_ID, routineId: r.id, source: "s2" });
      createRoutineRun({ workspaceId: WS_ID, routineId: r.id, source: "s3" });
      expect(listRoutineRuns(r.id, { limit: 2 })).toHaveLength(2);
    });

    it("listRoutineRuns filters by status", () => {
      const r = makeRoutine();
      const run1 = createRoutineRun({ workspaceId: WS_ID, routineId: r.id, source: "manual" });
      createRoutineRun({ workspaceId: WS_ID, routineId: r.id, source: "manual" });
      updateRoutineRun(run1.id, { status: "completed" });
      const completed = listRoutineRuns(r.id, { status: "completed" });
      expect(completed).toHaveLength(1);
      expect(completed[0].status).toBe("completed");
    });

    it("updateRoutineRun changes status and sets completedAt", () => {
      const r = makeRoutine();
      const run = createRoutineRun({ workspaceId: WS_ID, routineId: r.id, source: "manual" });
      const completedAt = Math.floor(Date.now() / 1000);
      const updated = updateRoutineRun(run.id, { status: "completed", completedAt });
      expect(updated.status).toBe("completed");
      expect(updated.completedAt).toBe(completedAt);
    });

    it("updateRoutineRun sets failureReason", () => {
      const r = makeRoutine();
      const run = createRoutineRun({ workspaceId: WS_ID, routineId: r.id, source: "manual" });
      const updated = updateRoutineRun(run.id, { status: "failed", failureReason: "timeout exceeded" });
      expect(updated.status).toBe("failed");
      expect(updated.failureReason).toBe("timeout exceeded");
    });

    it("updateRoutineRun throws for unknown run", () => {
      expect(() => updateRoutineRun("nonexistent", { status: "failed" })).toThrow("RoutineRun not found");
    });
  });
});

/**
 * Tests for delegation-tracker-sqlite.ts
 *
 * Covers:
 * - listActiveDelegations returns empty for unknown session key
 * - listActiveDelegations returns delegations for matching session key
 * - Status derivation: spawned / running / completed / failed / stale
 * - includeCompleted filtering
 * - limit parameter
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

type TestDb = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
let testDb: TestDb;

vi.mock("../infra/state-db/connection.js", () => ({ getStateDb: () => testDb }));
vi.mock("../infra/state-db/index.js", () => ({ getStateDb: () => testDb }));

import { listActiveDelegations } from "./delegation-tracker-sqlite.js";

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

// ── Helper ─────────────────────────────────────────────────────────────────

interface InsertRunOpts {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  task?: string;
  label?: string;
  createdAt?: number;
  startedAt?: number | null;
  endedAt?: number | null;
  outcomeJson?: string | null;
  cleanupCompletedAt?: number | null;
}

function insertRun(opts: InsertRunOpts): void {
  const now = Date.now();
  testDb
    .prepare(
      `INSERT INTO op1_subagent_runs (
        run_id, child_session_key, requester_session_key,
        task, label, created_at, started_at, ended_at,
        outcome_json, cleanup_completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.runId,
      opts.childSessionKey,
      opts.requesterSessionKey,
      opts.task ?? "test task",
      opts.label ?? null,
      opts.createdAt ?? now,
      opts.startedAt === undefined ? null : opts.startedAt,
      opts.endedAt === undefined ? null : opts.endedAt,
      opts.outcomeJson === undefined ? null : opts.outcomeJson,
      opts.cleanupCompletedAt === undefined ? null : opts.cleanupCompletedAt,
    );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("listActiveDelegations", () => {
  it("returns empty array for unknown session key", () => {
    const result = listActiveDelegations("agent:unknown:session");
    expect(result).toEqual([]);
  });

  it("returns delegations for matching requester session key", () => {
    const now = Date.now();
    insertRun({
      runId: "run-a",
      childSessionKey: "agent:neo:child:1",
      requesterSessionKey: "agent:operator1:main",
      task: "write report",
      label: "reporter",
      createdAt: now,
    });

    const result = listActiveDelegations("agent:operator1:main");
    expect(result).toHaveLength(1);
    expect(result[0].runId).toBe("run-a");
    expect(result[0].childSessionKey).toBe("agent:neo:child:1");
    expect(result[0].task).toBe("write report");
    expect(result[0].label).toBe("reporter");
  });

  it("does not return delegations from a different requester", () => {
    insertRun({
      runId: "run-other",
      childSessionKey: "agent:morpheus:child:1",
      requesterSessionKey: "agent:trinity:main",
    });

    const result = listActiveDelegations("agent:operator1:main");
    expect(result).toHaveLength(0);
  });

  // ── Status derivation ────────────────────────────────────────────────────

  describe("status derivation", () => {
    it("returns 'spawned' when started_at is null", () => {
      const now = Date.now();
      insertRun({
        runId: "run-spawned",
        childSessionKey: "agent:neo:child:spawned",
        requesterSessionKey: "agent:operator1:main",
        createdAt: now,
        startedAt: null,
        endedAt: null,
      });

      const result = listActiveDelegations("agent:operator1:main");
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe("spawned");
    });

    it("returns 'running' when started but not ended and within 10 minutes", () => {
      const now = Date.now();
      insertRun({
        runId: "run-running",
        childSessionKey: "agent:neo:child:running",
        requesterSessionKey: "agent:operator1:main",
        createdAt: now - 60_000,
        startedAt: now - 60_000, // started 1 minute ago
        endedAt: null,
      });

      const result = listActiveDelegations("agent:operator1:main");
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe("running");
    });

    it("returns 'stale' when running for more than 10 minutes", () => {
      const now = Date.now();
      insertRun({
        runId: "run-stale",
        childSessionKey: "agent:neo:child:stale",
        requesterSessionKey: "agent:operator1:main",
        createdAt: now - 700_000,
        startedAt: now - 700_000, // started ~11.7 minutes ago
        endedAt: null,
      });

      const result = listActiveDelegations("agent:operator1:main");
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe("stale");
    });

    it("returns 'completed' when ended with ok outcome", () => {
      const now = Date.now();
      insertRun({
        runId: "run-completed",
        childSessionKey: "agent:neo:child:completed",
        requesterSessionKey: "agent:operator1:main",
        createdAt: now - 5000,
        startedAt: now - 4000,
        endedAt: now - 1000,
        outcomeJson: JSON.stringify({ status: "ok" }),
      });

      const result = listActiveDelegations("agent:operator1:main", { includeCompleted: true });
      const run = result.find((r) => r.runId === "run-completed");
      expect(run?.status).toBe("completed");
    });

    it("returns 'completed' when ended with no outcome_json", () => {
      const now = Date.now();
      insertRun({
        runId: "run-completed-nooutcome",
        childSessionKey: "agent:neo:child:completed2",
        requesterSessionKey: "agent:operator1:main",
        createdAt: now - 5000,
        startedAt: now - 4000,
        endedAt: now - 1000,
        outcomeJson: null,
      });

      const result = listActiveDelegations("agent:operator1:main", { includeCompleted: true });
      const run = result.find((r) => r.runId === "run-completed-nooutcome");
      expect(run?.status).toBe("completed");
    });

    it("returns 'failed' when ended with interrupted status", () => {
      const now = Date.now();
      insertRun({
        runId: "run-interrupted",
        childSessionKey: "agent:neo:child:interrupted",
        requesterSessionKey: "agent:operator1:main",
        createdAt: now - 5000,
        startedAt: now - 4000,
        endedAt: now - 1000,
        outcomeJson: JSON.stringify({ status: "interrupted", reason: "gateway shutdown" }),
      });

      const result = listActiveDelegations("agent:operator1:main", { includeCompleted: true });
      const run = result.find((r) => r.runId === "run-interrupted");
      expect(run?.status).toBe("failed");
    });

    it("returns 'failed' when ended with error flag in outcome", () => {
      const now = Date.now();
      insertRun({
        runId: "run-error",
        childSessionKey: "agent:neo:child:error",
        requesterSessionKey: "agent:operator1:main",
        createdAt: now - 5000,
        startedAt: now - 4000,
        endedAt: now - 1000,
        outcomeJson: JSON.stringify({ error: "Something went wrong" }),
      });

      const result = listActiveDelegations("agent:operator1:main", { includeCompleted: true });
      const run = result.find((r) => r.runId === "run-error");
      expect(run?.status).toBe("failed");
    });

    it("returns 'failed' when ended with cancelled status", () => {
      const now = Date.now();
      insertRun({
        runId: "run-cancelled",
        childSessionKey: "agent:neo:child:cancelled",
        requesterSessionKey: "agent:operator1:main",
        createdAt: now - 5000,
        startedAt: now - 4000,
        endedAt: now - 1000,
        outcomeJson: JSON.stringify({ status: "cancelled" }),
      });

      const result = listActiveDelegations("agent:operator1:main", { includeCompleted: true });
      const run = result.find((r) => r.runId === "run-cancelled");
      expect(run?.status).toBe("failed");
    });
  });

  // ── includeCompleted filtering ───────────────────────────────────────────

  describe("includeCompleted option", () => {
    it("excludes runs with cleanup_completed_at set when includeCompleted is false (default)", () => {
      const now = Date.now();
      // Active run (no cleanup)
      insertRun({
        runId: "run-active",
        childSessionKey: "agent:neo:child:active",
        requesterSessionKey: "agent:operator1:main",
        createdAt: now,
        startedAt: null,
        endedAt: null,
        cleanupCompletedAt: null,
      });
      // Cleaned-up run
      insertRun({
        runId: "run-cleaned",
        childSessionKey: "agent:neo:child:cleaned",
        requesterSessionKey: "agent:operator1:main",
        createdAt: now - 10000,
        startedAt: now - 9000,
        endedAt: now - 5000,
        cleanupCompletedAt: now - 1000,
      });

      const result = listActiveDelegations("agent:operator1:main");
      expect(result).toHaveLength(1);
      expect(result[0].runId).toBe("run-active");
    });

    it("includes cleaned-up runs when includeCompleted is true", () => {
      const now = Date.now();
      insertRun({
        runId: "run-active2",
        childSessionKey: "agent:neo:child:active2",
        requesterSessionKey: "agent:operator1:main",
        createdAt: now,
        startedAt: null,
        cleanupCompletedAt: null,
      });
      insertRun({
        runId: "run-cleaned2",
        childSessionKey: "agent:neo:child:cleaned2",
        requesterSessionKey: "agent:operator1:main",
        createdAt: now - 10000,
        startedAt: now - 9000,
        endedAt: now - 5000,
        cleanupCompletedAt: now - 1000,
      });

      const result = listActiveDelegations("agent:operator1:main", { includeCompleted: true });
      expect(result).toHaveLength(2);
      const ids = result.map((r) => r.runId).toSorted();
      expect(ids).toEqual(["run-active2", "run-cleaned2"]);
    });
  });

  // ── limit parameter ──────────────────────────────────────────────────────

  describe("limit parameter", () => {
    it("respects the limit parameter", () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        insertRun({
          runId: `run-limit-${i}`,
          childSessionKey: `agent:neo:child:limit${i}`,
          requesterSessionKey: "agent:operator1:main",
          createdAt: now - i * 1000,
        });
      }

      const result = listActiveDelegations("agent:operator1:main", { limit: 3 });
      expect(result).toHaveLength(3);
    });

    it("defaults to returning up to 20 results", () => {
      const now = Date.now();
      for (let i = 0; i < 25; i++) {
        insertRun({
          runId: `run-default-limit-${i}`,
          childSessionKey: `agent:neo:child:default${i}`,
          requesterSessionKey: "agent:operator1:main",
          createdAt: now - i * 1000,
        });
      }

      const result = listActiveDelegations("agent:operator1:main");
      expect(result).toHaveLength(20);
    });
  });

  // ── elapsedMs ────────────────────────────────────────────────────────────

  it("computes elapsedMs from created_at to ended_at when ended", () => {
    const now = Date.now();
    const createdAt = now - 10_000;
    const endedAt = now - 2_000;

    insertRun({
      runId: "run-elapsed",
      childSessionKey: "agent:neo:child:elapsed",
      requesterSessionKey: "agent:operator1:main",
      createdAt,
      startedAt: now - 8_000,
      endedAt,
      cleanupCompletedAt: null,
      outcomeJson: JSON.stringify({ status: "ok" }),
    });

    const result = listActiveDelegations("agent:operator1:main", { includeCompleted: true });
    expect(result).toHaveLength(1);
    // elapsedMs should be approximately endedAt - createdAt = 8000ms
    expect(result[0].elapsedMs).toBeGreaterThanOrEqual(7_900);
    expect(result[0].elapsedMs).toBeLessThanOrEqual(8_100);
  });
});

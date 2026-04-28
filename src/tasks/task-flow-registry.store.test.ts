import { mkdirSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  requestFlowCancel,
  resetTaskFlowRegistryForTests,
  setFlowWaiting,
} from "./task-flow-registry.js";
import {
  resolveTaskFlowRegistryDir,
  resolveTaskFlowRegistrySqlitePath,
} from "./task-flow-registry.paths.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

function createStoredFlow(): TaskFlowRecord {
  return {
    flowId: "flow-restored",
    syncMode: "managed",
    ownerKey: "agent:main:main",
    controllerId: "tests/restored-controller",
    revision: 4,
    status: "blocked",
    notifyPolicy: "done_only",
    goal: "Restored flow",
    currentStep: "spawn_task",
    blockedTaskId: "task-restored",
    blockedSummary: "Writable session required.",
    stateJson: { lane: "triage", done: 3 },
    waitJson: { kind: "task", taskId: "task-restored" },
    cancelRequestedAt: 115,
    createdAt: 100,
    updatedAt: 120,
    endedAt: 120,
  };
}

async function withFlowRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-task-flow-store-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskFlowRegistryForTests();
    try {
      return await run(root);
    } finally {
      resetTaskFlowRegistryForTests();
    }
  });
}

function createFlowRegistryDb(sqlitePath: string) {
  mkdirSync(resolveTaskFlowRegistryDir(process.env), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  return new DatabaseSync(sqlitePath);
}

function listFlowRunsColumnNames(sqlitePath: string): string[] {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(sqlitePath);
  try {
    return (
      db.prepare(`PRAGMA table_info(flow_runs)`).all() as Array<{
        name?: string;
      }>
    )
      .map((row) => row.name ?? "")
      .filter(Boolean);
  } finally {
    db.close();
  }
}

describe("task-flow-registry store runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OPENCLAW_STATE_DIR;
    resetTaskFlowRegistryForTests();
  });

  it("uses the configured flow store for restore and save", () => {
    const storedFlow = createStoredFlow();
    const loadSnapshot = vi.fn(() => ({
      flows: new Map([[storedFlow.flowId, storedFlow]]),
    }));
    const saveSnapshot = vi.fn();
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot,
        saveSnapshot,
      },
    });

    expect(getTaskFlowById("flow-restored")).toMatchObject({
      flowId: "flow-restored",
      syncMode: "managed",
      controllerId: "tests/restored-controller",
      revision: 4,
      stateJson: { lane: "triage", done: 3 },
      waitJson: { kind: "task", taskId: "task-restored" },
      cancelRequestedAt: 115,
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/new-flow",
      goal: "New flow",
      status: "running",
      currentStep: "wait_for",
    });

    expect(saveSnapshot).toHaveBeenCalled();
    const latestSnapshot = saveSnapshot.mock.calls.at(-1)?.[0] as {
      flows: ReadonlyMap<string, TaskFlowRecord>;
    };
    expect(latestSnapshot.flows.size).toBe(2);
    expect(latestSnapshot.flows.get("flow-restored")?.goal).toBe("Restored flow");
  });

  it("restores persisted wait-state, revision, and cancel intent from sqlite", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/persisted-flow",
        goal: "Persisted flow",
        status: "running",
        currentStep: "spawn_task",
        stateJson: { phase: "spawn" },
      });
      const waiting = setFlowWaiting({
        flowId: created.flowId,
        expectedRevision: created.revision,
        currentStep: "ask_user",
        stateJson: { phase: "ask_user" },
        waitJson: { kind: "external_event", topic: "forum" },
      });
      expect(waiting).toMatchObject({
        applied: true,
      });
      const cancelRequested = requestFlowCancel({
        flowId: created.flowId,
        expectedRevision: waiting.applied ? waiting.flow.revision : -1,
        cancelRequestedAt: 444,
      });
      expect(cancelRequested).toMatchObject({
        applied: true,
      });

      resetTaskFlowRegistryForTests({ persist: false });

      expect(getTaskFlowById(created.flowId)).toMatchObject({
        flowId: created.flowId,
        syncMode: "managed",
        controllerId: "tests/persisted-flow",
        revision: 2,
        status: "waiting",
        currentStep: "ask_user",
        stateJson: { phase: "ask_user" },
        waitJson: { kind: "external_event", topic: "forum" },
        cancelRequestedAt: 444,
      });
    });
  });

  it("round-trips explicit json null through sqlite", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/null-roundtrip",
        goal: "Persist null payloads",
        stateJson: null,
        waitJson: null,
      });

      resetTaskFlowRegistryForTests({ persist: false });

      expect(getTaskFlowById(created.flowId)).toMatchObject({
        flowId: created.flowId,
        stateJson: null,
        waitJson: null,
      });
    });
  });

  it("keeps legacy owner_session_key rows writable after restore", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      const sqlitePath = resolveTaskFlowRegistrySqlitePath(process.env);
      const db = createFlowRegistryDb(sqlitePath);
      db.exec(`DROP TABLE IF EXISTS flow_runs;`);
      db.exec(`
        CREATE TABLE flow_runs (
          flow_id TEXT PRIMARY KEY,
          shape TEXT NOT NULL,
          owner_session_key TEXT NOT NULL,
          requester_origin_json TEXT,
          status TEXT NOT NULL,
          notify_policy TEXT NOT NULL,
          goal TEXT NOT NULL,
          current_step TEXT,
          blocked_task_id TEXT,
          blocked_summary TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          ended_at INTEGER
        );
      `);
      db.exec(`CREATE INDEX idx_flow_runs_owner_session_key ON flow_runs(owner_session_key);`);
      db.prepare(`
        INSERT INTO flow_runs (
          flow_id,
          shape,
          owner_session_key,
          status,
          notify_policy,
          goal,
          current_step,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "legacy-flow",
        "linear",
        "agent:main:main",
        "running",
        "done_only",
        "Legacy flow",
        "wait_for_user",
        100,
        110,
      );
      db.close();

      resetTaskFlowRegistryForTests({ persist: false });

      expect(getTaskFlowById("legacy-flow")).toMatchObject({
        flowId: "legacy-flow",
        syncMode: "managed",
        ownerKey: "agent:main:main",
        controllerId: "core/legacy-restored",
        revision: 0,
        currentStep: "wait_for_user",
      });
      expect(() =>
        createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/legacy-owner-session-key",
          goal: "Fresh flow after legacy restore",
        }),
      ).not.toThrow();

      resetTaskFlowRegistryForTests({ persist: false });

      expect(listFlowRunsColumnNames(sqlitePath)).toContain("owner_key");
      expect(listFlowRunsColumnNames(sqlitePath)).not.toContain("owner_session_key");
    });
  });

  it("repairs partially migrated owner_session_key schemas before new writes", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      const sqlitePath = resolveTaskFlowRegistrySqlitePath(process.env);
      const db = createFlowRegistryDb(sqlitePath);
      db.exec(`DROP TABLE IF EXISTS flow_runs;`);
      db.exec(`
        CREATE TABLE flow_runs (
          flow_id TEXT PRIMARY KEY,
          shape TEXT,
          owner_session_key TEXT NOT NULL,
          status TEXT NOT NULL,
          notify_policy TEXT NOT NULL,
          goal TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db.exec(`CREATE INDEX idx_flow_runs_owner_session_key ON flow_runs(owner_session_key);`);
      db.exec(`ALTER TABLE flow_runs ADD COLUMN owner_key TEXT;`);
      db.exec(`ALTER TABLE flow_runs ADD COLUMN sync_mode TEXT;`);
      db.exec(`ALTER TABLE flow_runs ADD COLUMN controller_id TEXT;`);
      db.exec(`ALTER TABLE flow_runs ADD COLUMN revision INTEGER;`);
      db.prepare(`
        INSERT INTO flow_runs (
          flow_id,
          shape,
          owner_session_key,
          owner_key,
          sync_mode,
          controller_id,
          revision,
          status,
          notify_policy,
          goal,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "partial-flow",
        "linear",
        "agent:main:main",
        "   ",
        null,
        "",
        null,
        "queued",
        "done_only",
        "Half migrated flow",
        200,
        200,
      );
      db.close();

      resetTaskFlowRegistryForTests({ persist: false });

      expect(getTaskFlowById("partial-flow")).toMatchObject({
        flowId: "partial-flow",
        syncMode: "managed",
        ownerKey: "agent:main:main",
        controllerId: "core/legacy-restored",
        revision: 0,
      });
      expect(() =>
        createManagedTaskFlow({
          ownerKey: "agent:main:main",
          controllerId: "tests/partial-owner-session-key",
          goal: "Fresh flow after partial migration repair",
        }),
      ).not.toThrow();

      resetTaskFlowRegistryForTests({ persist: false });

      const columns = listFlowRunsColumnNames(sqlitePath);
      expect(columns).toContain("owner_key");
      expect(columns).not.toContain("owner_session_key");
    });
  });

  it("hardens the sqlite flow store directory and file modes", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/secured-flow",
        goal: "Secured flow",
        status: "blocked",
        blockedTaskId: "task-secured",
        blockedSummary: "Need auth.",
        waitJson: { kind: "task", taskId: "task-secured" },
      });

      const registryDir = resolveTaskFlowRegistryDir(process.env);
      const sqlitePath = resolveTaskFlowRegistrySqlitePath(process.env);
      expect(statSync(registryDir).mode & 0o777).toBe(0o700);
      expect(statSync(sqlitePath).mode & 0o777).toBe(0o600);
    });
  });
});

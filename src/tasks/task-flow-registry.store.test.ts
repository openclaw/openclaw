import { mkdirSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  return await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-task-flow-store-",
    },
    async (state) => {
      const root = state.stateDir;
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();
      try {
        return await run(root);
      } finally {
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function restoreOriginalStateDir(): void {
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
}

describe("task-flow-registry store runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreOriginalStateDir();
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

  it("rebuilds legacy flow_runs tables that still require owner_session_key", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      const registryDir = resolveTaskFlowRegistryDir(process.env);
      const sqlitePath = resolveTaskFlowRegistrySqlitePath(process.env);
      mkdirSync(registryDir, { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(sqlitePath);
      db.exec(`DROP TABLE IF EXISTS flow_runs;`);
      db.exec(`
        CREATE TABLE flow_runs (
          flow_id TEXT PRIMARY KEY,
          owner_session_key TEXT NOT NULL,
          requester_origin_json TEXT,
          status TEXT NOT NULL,
          notify_policy TEXT NOT NULL,
          goal TEXT NOT NULL,
          current_step TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          ended_at INTEGER
        );
      `);
      db.prepare(`
        INSERT INTO flow_runs (
          flow_id,
          owner_session_key,
          requester_origin_json,
          status,
          notify_policy,
          goal,
          current_step,
          created_at,
          updated_at,
          ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "legacy-flow",
        "agent:test:legacy",
        null,
        "queued",
        "done_only",
        "Legacy flow",
        null,
        10,
        10,
        null,
      );
      db.close();

      resetTaskFlowRegistryForTests({ persist: false });

      expect(getTaskFlowById("legacy-flow")).toMatchObject({
        flowId: "legacy-flow",
        ownerKey: "agent:test:legacy",
        syncMode: "managed",
        controllerId: "core/legacy-restored",
        revision: 0,
        status: "queued",
      });

      const created = createManagedTaskFlow({
        ownerKey: "agent:test:fresh",
        controllerId: "tests/migrated-flow",
        goal: "Writable after migration",
      });
      expect(created).toMatchObject({
        ownerKey: "agent:test:fresh",
        syncMode: "managed",
        controllerId: "tests/migrated-flow",
      });

      const verifyDb = new DatabaseSync(sqlitePath);
      const columns = verifyDb.prepare(`PRAGMA table_info(flow_runs)`).all() as Array<{
        name?: string;
        notnull?: number;
      }>;
      expect(columns.some((column) => column.name === "owner_session_key")).toBe(false);
      expect(columns.find((column) => column.name === "owner_key")?.notnull).toBe(1);
      const rows = verifyDb
        .prepare(`
        SELECT flow_id, owner_key, sync_mode, controller_id, revision, status
        FROM flow_runs
        ORDER BY created_at ASC, flow_id ASC
      `)
        .all() as Array<{
        flow_id: string;
        owner_key: string;
        sync_mode: string;
        controller_id: string | null;
        revision: number;
        status: string;
      }>;
      verifyDb.close();

      expect(rows).toEqual([
        {
          flow_id: "legacy-flow",
          owner_key: "agent:test:legacy",
          sync_mode: "managed",
          controller_id: "core/legacy-restored",
          revision: 0,
          status: "queued",
        },
        {
          flow_id: created.flowId,
          owner_key: "agent:test:fresh",
          sync_mode: "managed",
          controller_id: "tests/migrated-flow",
          revision: 0,
          status: "queued",
        },
      ]);
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

import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  requestFlowCancel,
  resetTaskFlowRegistryForTests,
  setFlowWaiting,
} from "./task-flow-registry.js";
import {
  resolveLegacyTaskFlowRegistrySqlitePath,
  resolveTaskFlowRegistryDir,
  resolveTaskFlowRegistrySqlitePath,
} from "./task-flow-registry.paths.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import { importLegacyTaskFlowRegistrySidecarToSqlite } from "./task-flow-registry.store.sqlite.js";
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
    const latestCall = saveSnapshot.mock.calls.at(-1);
    if (!latestCall) {
      throw new Error("Expected task flow snapshot save call");
    }
    const latestSnapshot = latestCall[0] as {
      flows: ReadonlyMap<string, TaskFlowRecord>;
    };
    expect(latestSnapshot.flows.size).toBe(2);
    const restoredFlow = latestSnapshot.flows.get("flow-restored");
    if (!restoredFlow) {
      throw new Error("Expected restored task flow");
    }
    expect(restoredFlow.goal).toBe("Restored flow");
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
      expect(sqlitePath.endsWith(path.join("state", "openclaw.sqlite"))).toBe(true);
      expect(existsSync(resolveLegacyTaskFlowRegistrySqlitePath(process.env))).toBe(false);
      expect(statSync(registryDir).mode & 0o777).toBe(0o700);
      expect(statSync(sqlitePath).mode & 0o777).toBe(0o600);
    });
  });

  it("imports legacy Task Flow sidecar sqlite into the shared state database", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      const legacyPath = resolveLegacyTaskFlowRegistrySqlitePath(process.env);
      mkdirSync(path.dirname(legacyPath), { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(legacyPath);
      db.exec(`
        CREATE TABLE flow_runs (
          flow_id TEXT PRIMARY KEY,
          shape TEXT,
          sync_mode TEXT NOT NULL DEFAULT 'managed',
          owner_key TEXT NOT NULL,
          requester_origin_json TEXT,
          controller_id TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          notify_policy TEXT NOT NULL,
          goal TEXT NOT NULL,
          current_step TEXT,
          blocked_task_id TEXT,
          blocked_summary TEXT,
          state_json TEXT,
          wait_json TEXT,
          cancel_requested_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          ended_at INTEGER
        );
      `);
      db.prepare(`
        INSERT INTO flow_runs (
          flow_id,
          sync_mode,
          owner_key,
          controller_id,
          revision,
          status,
          notify_policy,
          goal,
          current_step,
          state_json,
          wait_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "legacy-sidecar-flow",
        "managed",
        "agent:main:main",
        "tests/legacy-flow",
        2,
        "waiting",
        "done_only",
        "Legacy sidecar flow",
        "wait",
        JSON.stringify({ phase: "wait" }),
        JSON.stringify({ kind: "external_event", topic: "forum" }),
        100,
        120,
      );
      db.close();

      const imported = importLegacyTaskFlowRegistrySidecarToSqlite(process.env);
      expect(imported).toMatchObject({
        importedFlows: 1,
        removedSource: true,
        sourcePath: legacyPath,
      });
      expect(existsSync(legacyPath)).toBe(false);

      resetTaskFlowRegistryForTests({ persist: false });

      expect(getTaskFlowById("legacy-sidecar-flow")).toMatchObject({
        flowId: "legacy-sidecar-flow",
        controllerId: "tests/legacy-flow",
        revision: 2,
        stateJson: { phase: "wait" },
        waitJson: { kind: "external_event", topic: "forum" },
      });
    });
  });
});

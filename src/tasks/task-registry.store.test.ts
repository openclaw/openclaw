import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createManagedTaskFlow, resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import {
  createTaskRecord,
  deleteTaskRecordById,
  findTaskByRunId,
  markTaskLostById,
  maybeDeliverTaskStateChangeUpdate,
  resetTaskRegistryForTests,
} from "./task-registry.js";
import { resolveTaskRegistryDir, resolveTaskRegistrySqlitePath } from "./task-registry.paths.js";
import {
  configureTaskRegistryRuntime,
  type TaskRegistryObserverEvent,
} from "./task-registry.store.js";
import {
  isTaskRegistrySqliteCorruptionError,
  loadTaskRegistryStateFromSqlite,
} from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function createStoredTask(): TaskRecord {
  return {
    taskId: "task-restored",
    runtime: "acp",
    sourceId: "run-restored",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: "agent:codex:acp:restored",
    runId: "run-restored",
    task: "Restored task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 100,
    lastEventAt: 100,
  };
}

type TaskRegistryQuarantineManifest = {
  reason: {
    code?: string;
    message: string;
  };
  files: Array<{
    name: string;
    size: number;
    sha256: string;
  }>;
};

function readSingleTaskRegistryQuarantineManifest(): {
  dir: string;
  manifest: TaskRegistryQuarantineManifest;
} {
  const quarantineBaseDir = path.join(resolveTaskRegistryDir(process.env), "quarantine");
  const entries = readdirSync(quarantineBaseDir).filter((entry) =>
    entry.startsWith("runs.sqlite."),
  );
  expect(entries).toHaveLength(1);
  const dir = path.join(quarantineBaseDir, entries[0] ?? "");
  const manifest = JSON.parse(
    readFileSync(path.join(dir, "manifest.json"), "utf8"),
  ) as TaskRegistryQuarantineManifest;
  return { dir, manifest };
}

function expectFreshTaskRegistrySqliteDatabase(sqlitePath: string, expectedTaskCount = 0) {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(sqlitePath);
  try {
    const quickCheck = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
    expect(quickCheck.quick_check).toBe("ok");
    const taskRuns = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_runs'")
      .get() as { name: string };
    expect(taskRuns.name).toBe("task_runs");
    const count = db.prepare("SELECT COUNT(*) AS count FROM task_runs").get() as { count: number };
    expect(count.count).toBe(expectedTaskCount);
  } finally {
    db.close();
  }
}

function readRequiredNumberColumn(
  row: Record<string, unknown> | undefined,
  column: string,
): number {
  const value = row?.[column];
  if (typeof value !== "number") {
    throw new Error(`Expected numeric sqlite column ${column}`);
  }
  return value;
}

function corruptTaskRunsRootPage(sqlitePath: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(sqlitePath);
  let pageSize = 4096;
  let rootPage = 2;
  try {
    pageSize = readRequiredNumberColumn(db.prepare("PRAGMA page_size").get(), "page_size");
    rootPage = readRequiredNumberColumn(
      db
        .prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'task_runs'")
        .get(),
      "rootpage",
    );
  } finally {
    db.close();
  }

  const bytes = readFileSync(sqlitePath);
  const offset = (rootPage - 1) * pageSize;
  bytes.fill(0xff, offset, Math.min(offset + 32, bytes.length));
  writeFileSync(sqlitePath, bytes);
}

describe("task-registry store runtime", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("uses the configured task store for restore and save", () => {
    const storedTask = createStoredTask();
    const loadSnapshot = vi.fn(() => ({
      tasks: new Map([[storedTask.taskId, storedTask]]),
      deliveryStates: new Map(),
    }));
    const saveSnapshot = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot,
        saveSnapshot,
      },
    });

    expect(findTaskByRunId("run-restored")).toMatchObject({
      taskId: "task-restored",
      task: "Restored task",
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-new",
      task: "New task",
      status: "running",
      deliveryStatus: "pending",
    });

    expect(saveSnapshot).toHaveBeenCalled();
    const latestSnapshot = saveSnapshot.mock.calls.at(-1)?.[0] as {
      tasks: ReadonlyMap<string, TaskRecord>;
    };
    expect(latestSnapshot.tasks.size).toBe(2);
    expect(latestSnapshot.tasks.get("task-restored")?.task).toBe("Restored task");
  });

  it("emits incremental observer events for restore, mutation, and delete", () => {
    const events: TaskRegistryObserverEvent[] = [];
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map([[createStoredTask().taskId, createStoredTask()]]),
          deliveryStates: new Map(),
        }),
        saveSnapshot: () => {},
      },
      observers: {
        onEvent: (event) => {
          events.push(event);
        },
      },
    });

    expect(findTaskByRunId("run-restored")).toBeTruthy();
    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-new",
      task: "New task",
      status: "running",
      deliveryStatus: "pending",
    });
    expect(deleteTaskRecordById(created.taskId)).toBe(true);

    expect(events.map((event) => event.kind)).toEqual(["restored", "upserted", "deleted"]);
    expect(events[0]).toMatchObject({
      kind: "restored",
      tasks: [expect.objectContaining({ taskId: "task-restored" })],
    });
    expect(events[1]).toMatchObject({
      kind: "upserted",
      task: expect.objectContaining({ taskId: created.taskId }),
    });
    expect(events[2]).toMatchObject({
      kind: "deleted",
      taskId: created.taskId,
    });
  });

  it("uses atomic task-plus-delivery store methods when available", async () => {
    const upsertTaskWithDeliveryState = vi.fn();
    const deleteTaskWithDeliveryState = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map(),
          deliveryStates: new Map(),
        }),
        saveSnapshot: vi.fn(),
        upsertTaskWithDeliveryState,
        deleteTaskWithDeliveryState,
      },
    });

    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-atomic",
      task: "Atomic task",
      status: "running",
      notifyPolicy: "state_changes",
      deliveryStatus: "pending",
    });

    await maybeDeliverTaskStateChangeUpdate(created.taskId, {
      at: 200,
      kind: "progress",
      summary: "working",
    });
    expect(deleteTaskRecordById(created.taskId)).toBe(true);

    expect(upsertTaskWithDeliveryState).toHaveBeenCalled();
    expect(upsertTaskWithDeliveryState.mock.calls[0]?.[0]).toMatchObject({
      task: expect.objectContaining({
        taskId: created.taskId,
      }),
    });
    expect(
      upsertTaskWithDeliveryState.mock.calls.some((call) => {
        const params = call[0] as { deliveryState?: { lastNotifiedEventAt?: number } };
        return params.deliveryState?.lastNotifiedEventAt === 200;
      }),
    ).toBe(true);
    expect(deleteTaskWithDeliveryState).toHaveBeenCalledWith(created.taskId);
  });

  it("restores persisted tasks from the default sqlite store", () => {
    const created = createTaskRecord({
      runtime: "cron",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      sourceId: "job-123",
      runId: "run-sqlite",
      task: "Run nightly cron",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("run-sqlite")).toMatchObject({
      taskId: created.taskId,
      sourceId: "job-123",
      task: "Run nightly cron",
    });
  });

  it("persists parentFlowId with task rows", () => {
    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/task-store-parent-flow",
      goal: "Persist linked tasks",
    });
    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      parentFlowId: flow.flowId,
      childSessionKey: "agent:codex:acp:new",
      runId: "run-flow-linked",
      task: "Linked task",
      status: "running",
      deliveryStatus: "pending",
    });

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("run-flow-linked")).toMatchObject({
      taskId: created.taskId,
      parentFlowId: flow.flowId,
    });
  });

  it("preserves requesterSessionKey when it differs from ownerKey across sqlite restore", () => {
    const created = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:workspace:channel:C1234567890",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:workspace:channel:C1234567890",
      runId: "run-requester-session-restore",
      task: "Reply to channel task",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
    });

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("run-requester-session-restore")).toMatchObject({
      taskId: created.taskId,
      requesterSessionKey: "agent:main:workspace:channel:C1234567890",
      ownerKey: "agent:main:main",
      childSessionKey: "agent:main:workspace:channel:C1234567890",
    });
  });

  it("preserves taskKind across sqlite restore", () => {
    const created = createTaskRecord({
      runtime: "acp",
      taskKind: "video_generation",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:video",
      runId: "run-task-kind-restore",
      task: "Render a short clip",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
    });

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("run-task-kind-restore")).toMatchObject({
      taskId: created.taskId,
      taskKind: "video_generation",
      runId: "run-task-kind-restore",
    });
  });

  it("hardens the sqlite task store directory and file modes", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-" },
      async () => {
        createTaskRecord({
          runtime: "cron",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          sourceId: "job-456",
          runId: "run-perms",
          task: "Run secured cron",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
        });

        const registryDir = resolveTaskRegistryDir(process.env);
        const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
        expect(statSync(registryDir).mode & 0o777).toBe(0o700);
        expect(statSync(sqlitePath).mode & 0o777).toBe(0o600);
      },
    );
  });

  it("quarantines a malformed sqlite store and sidecars before recreating a fresh database", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-corrupt-" },
      async () => {
        const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
        mkdirSync(path.dirname(sqlitePath), { recursive: true });
        writeFileSync(sqlitePath, "not sqlite at all", "utf8");
        writeFileSync(`${sqlitePath}-wal`, "wal bytes", "utf8");
        writeFileSync(`${sqlitePath}-shm`, "shm bytes", "utf8");

        expect(findTaskByRunId("missing-corrupt-run")).toBeUndefined();
        resetTaskRegistryForTests({ persist: false });

        const { dir, manifest } = readSingleTaskRegistryQuarantineManifest();
        expect(manifest.reason.code).toBe("ERR_SQLITE_ERROR");
        expect(manifest.reason.message).toContain("file is not a database");
        expect(new Set(manifest.files.map((file) => file.name))).toEqual(
          new Set(["runs.sqlite", "runs.sqlite-wal", "runs.sqlite-shm"]),
        );
        expect(readFileSync(path.join(dir, "runs.sqlite"), "utf8")).toBe("not sqlite at all");
        expect(readFileSync(path.join(dir, "runs.sqlite-wal"), "utf8")).toBe("wal bytes");
        expect(readFileSync(path.join(dir, "runs.sqlite-shm"), "utf8")).toBe("shm bytes");
        expectFreshTaskRegistrySqliteDatabase(sqlitePath);
        if (process.platform !== "win32") {
          expect(statSync(dir).mode & 0o777).toBe(0o700);
          expect(statSync(path.join(dir, "manifest.json")).mode & 0o777).toBe(0o600);
          expect(statSync(path.join(dir, "runs.sqlite")).mode & 0o777).toBe(0o600);
        }
      },
    );
  });

  it("preserves sidecars before closing a corrupt sqlite handle", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-valid-header-corrupt-" },
      async () => {
        const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
        mkdirSync(path.dirname(sqlitePath), { recursive: true });
        const bytes = Buffer.alloc(4096, 0xff);
        Buffer.from("SQLite format 3\0", "binary").copy(bytes, 0);
        writeFileSync(sqlitePath, bytes);
        writeFileSync(`${sqlitePath}-wal`, "wal bytes", "utf8");
        writeFileSync(`${sqlitePath}-shm`, "shm bytes", "utf8");

        expect(findTaskByRunId("missing-corrupt-run")).toBeUndefined();
        resetTaskRegistryForTests({ persist: false });

        const { dir, manifest } = readSingleTaskRegistryQuarantineManifest();
        expect(manifest.reason.message).toContain("file is not a database");
        expect(new Set(manifest.files.map((file) => file.name))).toEqual(
          new Set(["runs.sqlite", "runs.sqlite-wal", "runs.sqlite-shm"]),
        );
        expect(readFileSync(path.join(dir, "runs.sqlite-wal"), "utf8")).toBe("wal bytes");
        expect(statSync(path.join(dir, "runs.sqlite-shm")).size).toBeGreaterThan(0);
        expectFreshTaskRegistrySqliteDatabase(sqlitePath);
      },
    );
  });

  it("closes a corrupt cached sqlite handle before recreating and writing to the fresh store", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-scan-corrupt-" },
      async () => {
        const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
        createTaskRecord({
          runtime: "cron",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          sourceId: "job-corrupt-root",
          runId: "run-before-corruption",
          task: "Task before corruption",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
        });
        resetTaskRegistryForTests({ persist: false });
        corruptTaskRunsRootPage(sqlitePath);

        const snapshot = loadTaskRegistryStateFromSqlite();
        expect(snapshot.tasks.size).toBe(0);
        expect(snapshot.deliveryStates.size).toBe(0);

        const { manifest } = readSingleTaskRegistryQuarantineManifest();
        expect(manifest.files.some((file) => file.name === "runs.sqlite")).toBe(true);

        const recreated = createTaskRecord({
          runtime: "cron",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          sourceId: "job-after-corruption",
          runId: "run-after-corruption",
          task: "Task after corruption",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
        });

        expect(findTaskByRunId("run-before-corruption")).toBeUndefined();
        expect(findTaskByRunId("run-after-corruption")).toMatchObject({
          taskId: recreated.taskId,
          task: "Task after corruption",
        });
        resetTaskRegistryForTests({ persist: false });
        expectFreshTaskRegistrySqliteDatabase(sqlitePath, 1);
      },
    );
  });

  it("classifies only known sqlite corruption messages for quarantine fallback", () => {
    const malformed = Object.assign(new Error("database disk image is malformed"), {
      code: "ERR_SQLITE_ERROR",
    });
    const busy = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_BUSY" });
    const diskFull = Object.assign(new Error("database or disk is full"), {
      code: "ERR_SQLITE_FULL",
    });
    const permission = Object.assign(new Error("unable to open database file"), {
      code: "ERR_SQLITE_CANTOPEN",
    });

    expect(isTaskRegistrySqliteCorruptionError(malformed)).toBe(true);
    expect(isTaskRegistrySqliteCorruptionError(busy)).toBe(false);
    expect(isTaskRegistrySqliteCorruptionError(diskFull)).toBe(false);
    expect(isTaskRegistrySqliteCorruptionError(permission)).toBe(false);
  });

  it("migrates legacy ownerless cron rows to system scope", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-legacy-" },
      async () => {
        const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
        mkdirSync(path.dirname(sqlitePath), { recursive: true });
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(sqlitePath);
        db.exec(`
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        source_id TEXT,
        requester_session_key TEXT NOT NULL,
        child_session_key TEXT,
        parent_task_id TEXT,
        agent_id TEXT,
        run_id TEXT,
        label TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        notify_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        last_event_at INTEGER,
        cleanup_after INTEGER,
        error TEXT,
        progress_summary TEXT,
        terminal_summary TEXT,
        terminal_outcome TEXT
      );
    `);
        db.exec(`
      CREATE TABLE task_delivery_state (
        task_id TEXT PRIMARY KEY,
        requester_origin_json TEXT,
        last_notified_event_at INTEGER
      );
    `);
        db.prepare(`
      INSERT INTO task_runs (
        task_id,
        runtime,
        source_id,
        requester_session_key,
        child_session_key,
        run_id,
        task,
        status,
        delivery_status,
        notify_policy,
        created_at,
        last_event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
          "legacy-cron-task",
          "cron",
          "nightly-digest",
          "",
          "agent:main:cron:nightly-digest",
          "legacy-cron-run",
          "Nightly digest",
          "running",
          "not_applicable",
          "silent",
          100,
          100,
        );
        db.close();

        resetTaskRegistryForTests({ persist: false });

        expect(findTaskByRunId("legacy-cron-run")).toMatchObject({
          taskId: "legacy-cron-task",
          ownerKey: "system:cron:nightly-digest",
          scopeKind: "system",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
        });
      },
    );
  });

  it("keeps legacy requester_session_key rows writable after restore", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-legacy-write-" },
      async () => {
        const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
        mkdirSync(path.dirname(sqlitePath), { recursive: true });
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(sqlitePath);
        db.exec(`
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        source_id TEXT,
        requester_session_key TEXT NOT NULL,
        child_session_key TEXT,
        parent_task_id TEXT,
        agent_id TEXT,
        run_id TEXT,
        label TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        notify_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        last_event_at INTEGER,
        cleanup_after INTEGER,
        error TEXT,
        progress_summary TEXT,
        terminal_summary TEXT,
        terminal_outcome TEXT
      );
    `);
        db.exec(`
      CREATE TABLE task_delivery_state (
        task_id TEXT PRIMARY KEY,
        requester_origin_json TEXT,
        last_notified_event_at INTEGER
      );
    `);
        db.prepare(`
      INSERT INTO task_runs (
        task_id,
        runtime,
        requester_session_key,
        run_id,
        task,
        status,
        delivery_status,
        notify_policy,
        created_at,
        last_event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
          "legacy-session-task",
          "acp",
          "agent:main:main",
          "legacy-session-run",
          "Legacy session task",
          "running",
          "pending",
          "done_only",
          100,
          100,
        );
        db.close();

        resetTaskRegistryForTests({ persist: false });

        expect(() =>
          markTaskLostById({
            taskId: "legacy-session-task",
            endedAt: 200,
            lastEventAt: 200,
            error: "session missing",
          }),
        ).not.toThrow();
        expect(findTaskByRunId("legacy-session-run")).toMatchObject({
          taskId: "legacy-session-task",
          status: "lost",
          error: "session missing",
        });
      },
    );
  });
});

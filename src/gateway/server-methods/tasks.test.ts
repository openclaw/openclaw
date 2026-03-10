import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliverTaskNotification,
  loadTaskRegistry,
  saveTaskRegistry,
  taskHandlers,
  type TaskEntry,
  type TaskRegistry,
} from "./tasks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: "build-123",
    description: "Implement feature X",
    createdAt: 1700000000000,
    watchers: [],
    events: [],
    notifiedEvents: {},
    ...overrides,
  };
}

function makeRegistry(tasks: TaskEntry[]): TaskRegistry {
  return { tasks };
}

function writeRegistry(dir: string, tasks: TaskEntry[]): string {
  const file = path.join(dir, "task-registry.json");
  fs.writeFileSync(file, JSON.stringify(makeRegistry(tasks), null, 2), "utf8");
  return file;
}

// Simulate invoking a gateway handler and capturing the respond call.
function runHandler(
  method: string,
  params: Record<string, unknown>,
  contextOverrides?: Record<string, unknown>,
): Promise<{ ok: boolean; payload: unknown; error?: unknown }> {
  return new Promise((resolve) => {
    const respond = (ok: boolean, payload: unknown, error?: unknown) => {
      resolve({ ok, payload, error });
    };
    void taskHandlers[method]({
      params,
      respond: respond as never,
      context: { deps: {}, ...contextOverrides } as never,
      client: null,
      req: { id: "r1", type: "req", method },
      isWebchatConnect: () => false,
    });
  });
}

// ---------------------------------------------------------------------------
// loadTaskRegistry / saveTaskRegistry
// ---------------------------------------------------------------------------

describe("loadTaskRegistry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty registry when file is missing", () => {
    const result = loadTaskRegistry(path.join(tmpDir, "missing.json"));
    expect(result).toEqual({ tasks: [] });
  });

  it("parses an existing registry file", () => {
    const file = writeRegistry(tmpDir, [makeTask()]);
    const result = loadTaskRegistry(file);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe("build-123");
  });
});

describe("saveTaskRegistry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the directory if needed and writes atomically", () => {
    const file = path.join(tmpDir, "sub", "task-registry.json");
    const registry = makeRegistry([makeTask()]);
    saveTaskRegistry(registry, file);
    expect(fs.existsSync(file)).toBe(true);
    const read = JSON.parse(fs.readFileSync(file, "utf8")) as TaskRegistry;
    expect(read.tasks[0]?.id).toBe("build-123");
    // Temp file should be cleaned up
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deliverTaskNotification
// ---------------------------------------------------------------------------

describe("deliverTaskNotification", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-notify-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns skipped='task not found' when task absent", async () => {
    const registryPath = writeRegistry(tmpDir, []);
    const sendToSession = vi.fn();
    const result = await deliverTaskNotification({
      taskId: "nonexistent",
      event: "completed",
      message: "done",
      registryPath,
      sendToSession,
    });
    expect(result.skipped).toBe("task not found");
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it("normalizes empty/whitespace idempotency key to event name", async () => {
    const registryPath = writeRegistry(tmpDir, [
      makeTask({ id: "t1", watchers: [{ sessionKey: "s1", addedAt: Date.now() }] }),
    ]);
    const sendToSession = vi.fn().mockResolvedValue(undefined);
    // First call with empty key — should succeed using event name as key
    await deliverTaskNotification({
      taskId: "t1",
      event: "done",
      message: "msg",
      idempotencyKey: "",
      registryPath,
      sendToSession,
    });
    // Second call with whitespace key — should be treated as idempotent (same event name key)
    const result = await deliverTaskNotification({
      taskId: "t1",
      event: "done",
      message: "msg2",
      idempotencyKey: "   ",
      registryPath,
      sendToSession,
    });
    expect(result.skipped).toBe("already delivered");
    expect(sendToSession).toHaveBeenCalledTimes(1);
  });

  it("caps notifiedEvents map at MAX_TASK_EVENTS entries", async () => {
    // Fill task with 50 existing idempotency entries
    const existing: Record<string, boolean> = {};
    for (let i = 0; i < 50; i++) {
      existing[`event-${i}`] = true;
    }
    const registryPath = writeRegistry(tmpDir, [
      makeTask({
        id: "t1",
        watchers: [{ sessionKey: "s1", addedAt: Date.now() }],
        notifiedEvents: existing,
      }),
    ]);
    const sendToSession = vi.fn().mockResolvedValue(undefined);
    await deliverTaskNotification({
      taskId: "t1",
      event: "event-new",
      message: "msg",
      registryPath,
      sendToSession,
    });
    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8")) as TaskRegistry;
    const keys = Object.keys(updated.tasks[0].notifiedEvents);
    expect(keys.length).toBeLessThanOrEqual(50);
    // New key should be present; oldest key should have been pruned
    expect(updated.tasks[0].notifiedEvents["event-new"]).toBe(true);
    expect(updated.tasks[0].notifiedEvents["event-0"]).toBeUndefined();
  });

  it("returns skipped='already delivered' when idempotency key already set", async () => {
    const registryPath = writeRegistry(tmpDir, [
      makeTask({
        id: "t1",
        watchers: [{ sessionKey: "agent:main:main", addedAt: Date.now() }],
        notifiedEvents: { completed: true },
      }),
    ]);
    const sendToSession = vi.fn();
    const result = await deliverTaskNotification({
      taskId: "t1",
      event: "completed",
      message: "done",
      registryPath,
      sendToSession,
    });
    expect(result.skipped).toBe("already delivered");
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it("delivers to all watchers and returns their session keys", async () => {
    const registryPath = writeRegistry(tmpDir, [
      makeTask({
        id: "t1",
        watchers: [
          { sessionKey: "agent:main:main", addedAt: Date.now() },
          { sessionKey: "agent:main:slack:C123", addedAt: Date.now() },
        ],
      }),
    ]);
    const sendToSession = vi.fn().mockResolvedValue(undefined);
    const result = await deliverTaskNotification({
      taskId: "t1",
      event: "completed",
      message: "PR #42 merged",
      registryPath,
      sendToSession,
    });
    expect(sendToSession).toHaveBeenCalledTimes(2);
    expect(sendToSession).toHaveBeenCalledWith("agent:main:main", "PR #42 merged");
    expect(sendToSession).toHaveBeenCalledWith("agent:main:slack:C123", "PR #42 merged");
    expect(result.delivered).toEqual(["agent:main:main", "agent:main:slack:C123"]);
    expect(result.failed).toEqual([]);
  });

  it("marks idempotency key after successful delivery", async () => {
    const registryPath = writeRegistry(tmpDir, [
      makeTask({
        id: "t1",
        watchers: [{ sessionKey: "agent:main:main", addedAt: Date.now() }],
      }),
    ]);
    const sendToSession = vi.fn().mockResolvedValue(undefined);
    await deliverTaskNotification({
      taskId: "t1",
      event: "completed",
      message: "done",
      registryPath,
      sendToSession,
    });
    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8")) as TaskRegistry;
    expect(updated.tasks[0]?.notifiedEvents["completed"]).toBe(true);
  });

  it("uses custom idempotencyKey instead of event name", async () => {
    const registryPath = writeRegistry(tmpDir, [
      makeTask({
        id: "t1",
        watchers: [{ sessionKey: "agent:main:main", addedAt: Date.now() }],
      }),
    ]);
    const sendToSession = vi.fn().mockResolvedValue(undefined);
    await deliverTaskNotification({
      taskId: "t1",
      event: "progress",
      message: "50% done",
      idempotencyKey: "progress-step-1",
      registryPath,
      sendToSession,
    });
    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8")) as TaskRegistry;
    expect(updated.tasks[0]?.notifiedEvents["progress-step-1"]).toBe(true);
    expect(updated.tasks[0]?.notifiedEvents["progress"]).toBeUndefined();
  });

  it("logs the event in task.events", async () => {
    const registryPath = writeRegistry(tmpDir, [
      makeTask({ id: "t1", watchers: [{ sessionKey: "sk", addedAt: Date.now() }] }),
    ]);
    const sendToSession = vi.fn().mockResolvedValue(undefined);
    await deliverTaskNotification({
      taskId: "t1",
      event: "completed",
      message: "All done",
      registryPath,
      sendToSession,
    });
    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8")) as TaskRegistry;
    const events = updated.tasks[0]?.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("completed");
    expect(events[0]?.message).toBe("All done");
  });

  it("caps events list at 50", async () => {
    const existing = Array.from({ length: 50 }, (_, i) => ({
      event: "tick",
      message: `tick ${i}`,
      timestamp: Date.now(),
    }));
    const registryPath = writeRegistry(tmpDir, [
      makeTask({ id: "t1", events: existing, watchers: [] }),
    ]);
    const sendToSession = vi.fn();
    await deliverTaskNotification({
      taskId: "t1",
      event: "completed",
      message: "done",
      registryPath,
      sendToSession,
    });
    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8")) as TaskRegistry;
    expect(updated.tasks[0]?.events).toHaveLength(50);
    // The new event replaces the oldest
    const last = updated.tasks[0]?.events[49];
    expect(last?.event).toBe("completed");
  });

  it("updates task.status when provided", async () => {
    const registryPath = writeRegistry(tmpDir, [
      makeTask({ id: "t1", status: "running", watchers: [] }),
    ]);
    const sendToSession = vi.fn();
    await deliverTaskNotification({
      taskId: "t1",
      event: "completed",
      message: "done",
      status: "done",
      registryPath,
      sendToSession,
    });
    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8")) as TaskRegistry;
    expect(updated.tasks[0]?.status).toBe("done");
  });

  it("continues delivery even if one watcher throws", async () => {
    const registryPath = writeRegistry(tmpDir, [
      makeTask({
        id: "t1",
        watchers: [
          { sessionKey: "bad-session", addedAt: Date.now() },
          { sessionKey: "good-session", addedAt: Date.now() },
        ],
      }),
    ]);
    const sendToSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("session not found"))
      .mockResolvedValueOnce(undefined);
    const result = await deliverTaskNotification({
      taskId: "t1",
      event: "completed",
      message: "done",
      registryPath,
      sendToSession,
    });
    expect(result.delivered).toEqual(["good-session"]);
    expect(result.failed).toEqual(["bad-session"]);
    // Idempotency key must NOT be set on partial failure so failed watchers can be retried
    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8")) as TaskRegistry;
    expect(updated.tasks[0]?.notifiedEvents["completed"]).toBeUndefined();
  });

  it("marks idempotency key for tasks with no watchers", async () => {
    const registryPath = writeRegistry(tmpDir, [makeTask({ id: "t1", watchers: [] })]);
    const sendToSession = vi.fn();
    await deliverTaskNotification({
      taskId: "t1",
      event: "completed",
      message: "done",
      registryPath,
      sendToSession,
    });
    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8")) as TaskRegistry;
    expect(updated.tasks[0]?.notifiedEvents["completed"]).toBe(true);
  });

  it("does not mark idempotency key when all deliveries fail", async () => {
    const registryPath = writeRegistry(tmpDir, [
      makeTask({ id: "t1", watchers: [{ sessionKey: "bad-session", addedAt: Date.now() }] }),
    ]);
    const sendToSession = vi.fn().mockRejectedValue(new Error("failed"));
    const result = await deliverTaskNotification({
      taskId: "t1",
      event: "completed",
      message: "done",
      registryPath,
      sendToSession,
    });
    expect(result.delivered).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8")) as TaskRegistry;
    // Not marked delivered since nothing got through
    expect(updated.tasks[0]?.notifiedEvents["completed"]).toBeUndefined();
  });

  it("does not append duplicate event log entries on repeated failed retries", async () => {
    const registryPath = writeRegistry(tmpDir, [
      makeTask({ id: "t1", watchers: [{ sessionKey: "bad-session", addedAt: Date.now() }] }),
    ]);
    const sendToSession = vi.fn().mockRejectedValue(new Error("failed"));
    // Fire same event twice (simulating retries)
    await deliverTaskNotification({
      taskId: "t1",
      event: "completed",
      message: "done",
      registryPath,
      sendToSession,
    });
    await deliverTaskNotification({
      taskId: "t1",
      event: "completed",
      message: "done",
      registryPath,
      sendToSession,
    });
    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8")) as TaskRegistry;
    // Event log should remain empty since no delivery succeeded
    expect(updated.tasks[0]?.events).toHaveLength(0);
  });

  it("does not resurrect a task removed concurrently during async sends", async () => {
    const registryPath = writeRegistry(tmpDir, [
      makeTask({ id: "t1", watchers: [{ sessionKey: "s1", addedAt: Date.now() }] }),
    ]);
    const sendToSession = vi.fn().mockImplementation(async () => {
      // Simulate concurrent task removal during send
      const reg = JSON.parse(fs.readFileSync(registryPath, "utf8")) as TaskRegistry;
      reg.tasks = reg.tasks.filter((t) => t.id !== "t1");
      fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2));
    });
    const result = await deliverTaskNotification({
      taskId: "t1",
      event: "completed",
      message: "done",
      registryPath,
      sendToSession,
    });
    expect(result.delivered).toEqual(["s1"]);
    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8")) as TaskRegistry;
    // Task should not have been re-created by the registry write
    expect(updated.tasks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// tasks.register handler
// ---------------------------------------------------------------------------

describe("tasks.register", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-register-test-"));
    origHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, ".openclaw"), { recursive: true });
  });
  afterEach(() => {
    process.env["HOME"] = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects missing taskId", async () => {
    const { ok, error } = await runHandler("tasks.register", {});
    expect(ok).toBe(false);
    expect((error as { message: string }).message).toMatch(/taskId/);
  });

  it("creates a new task", async () => {
    const { ok, payload } = await runHandler("tasks.register", {
      taskId: "my-task",
      description: "Do something",
      status: "running",
    });
    expect(ok).toBe(true);
    const task = (payload as { task: TaskEntry }).task;
    expect(task.id).toBe("my-task");
    expect(task.description).toBe("Do something");
    expect(task.status).toBe("running");
    expect(task.watchers).toEqual([]);
    expect(task.events).toEqual([]);
    expect(task.notifiedEvents).toEqual({});
  });

  it("updates existing task (merges, not replaces)", async () => {
    // Create first
    await runHandler("tasks.register", {
      taskId: "my-task",
      description: "Original",
      metadata: { repo: "/repo" },
    });
    // Update
    const { ok, payload } = await runHandler("tasks.register", {
      taskId: "my-task",
      description: "Updated",
      metadata: { branch: "main" },
    });
    expect(ok).toBe(true);
    const task = (payload as { task: TaskEntry }).task;
    expect(task.description).toBe("Updated");
    // metadata should be merged
    expect(task.metadata).toMatchObject({ repo: "/repo", branch: "main" });
    // updatedAt should be set
    expect(task.updatedAt).toBeDefined();
  });

  it("preserves watchers and events when updating", async () => {
    // Create and manually add a watcher
    await runHandler("tasks.register", { taskId: "t1" });
    await runHandler("tasks.watch", { taskId: "t1", sessionKey: "agent:main:main" });
    // Update the task
    const { payload } = await runHandler("tasks.register", {
      taskId: "t1",
      status: "done",
    });
    const task = (payload as { task: TaskEntry }).task;
    expect(task.watchers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// tasks.watch handler
// ---------------------------------------------------------------------------

describe("tasks.watch", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-watch-test-"));
    origHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, ".openclaw"), { recursive: true });
  });
  afterEach(() => {
    process.env["HOME"] = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects missing taskId", async () => {
    const { ok, error } = await runHandler("tasks.watch", { sessionKey: "sk" });
    expect(ok).toBe(false);
    expect((error as { message: string }).message).toMatch(/taskId/);
  });

  it("rejects missing sessionKey", async () => {
    const { ok, error } = await runHandler("tasks.watch", { taskId: "t1" });
    expect(ok).toBe(false);
    expect((error as { message: string }).message).toMatch(/sessionKey/);
  });

  it("rejects task not found", async () => {
    const { ok, error } = await runHandler("tasks.watch", {
      taskId: "nonexistent",
      sessionKey: "sk",
    });
    expect(ok).toBe(false);
    expect((error as { message: string }).message).toMatch(/task not found/);
  });

  it("adds a watcher and returns watcherCount", async () => {
    await runHandler("tasks.register", { taskId: "t1" });
    const { ok, payload } = await runHandler("tasks.watch", {
      taskId: "t1",
      sessionKey: "agent:main:main",
      label: "main session",
    });
    expect(ok).toBe(true);
    expect((payload as { watcherCount: number }).watcherCount).toBe(1);
  });

  it("is idempotent: watching same session twice does not duplicate", async () => {
    await runHandler("tasks.register", { taskId: "t1" });
    await runHandler("tasks.watch", { taskId: "t1", sessionKey: "agent:main:main" });
    const { payload } = await runHandler("tasks.watch", {
      taskId: "t1",
      sessionKey: "agent:main:main",
    });
    expect((payload as { watcherCount: number }).watcherCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// tasks.notify handler
// ---------------------------------------------------------------------------

describe("tasks.notify validation", () => {
  it("rejects missing taskId", async () => {
    const { ok, error } = await runHandler("tasks.notify", {
      event: "completed",
      message: "done",
    });
    expect(ok).toBe(false);
    expect((error as { message: string }).message).toMatch(/taskId/);
  });

  it("rejects missing event", async () => {
    const { ok, error } = await runHandler("tasks.notify", {
      taskId: "t1",
      message: "done",
    });
    expect(ok).toBe(false);
    expect((error as { message: string }).message).toMatch(/event/);
  });

  it("rejects missing message", async () => {
    const { ok, error } = await runHandler("tasks.notify", {
      taskId: "t1",
      event: "completed",
    });
    expect(ok).toBe(false);
    expect((error as { message: string }).message).toMatch(/message/);
  });
});

describe("tasks.notify delivery", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-notify-test-"));
    origHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, ".openclaw"), { recursive: true });
  });
  afterEach(() => {
    process.env["HOME"] = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects task not found", async () => {
    const { ok, error } = await runHandler("tasks.notify", {
      taskId: "nonexistent",
      event: "completed",
      message: "done",
    });
    expect(ok).toBe(false);
    expect((error as { message: string }).message).toMatch(/task not found/);
  });

  it("returns delivered/failed arrays", async () => {
    await runHandler("tasks.register", { taskId: "t1" });
    await runHandler("tasks.watch", { taskId: "t1", sessionKey: "agent:main:main" });

    // Patch agentCommandFromIngress to be a no-op in tests
    const agentMod = await import("../../commands/agent.js");
    const spy = vi.spyOn(agentMod, "agentCommandFromIngress").mockResolvedValue(undefined as never);

    const { ok, payload } = await runHandler("tasks.notify", {
      taskId: "t1",
      event: "completed",
      message: "All done",
    });

    expect(ok).toBe(true);
    const result = payload as { delivered: string[]; failed: string[] };
    expect(result.delivered).toContain("agent:main:main");
    expect(result.failed).toHaveLength(0);

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// tasks.list handler
// ---------------------------------------------------------------------------

describe("tasks.list", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-list-test-"));
    origHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, ".openclaw"), { recursive: true });
  });
  afterEach(() => {
    process.env["HOME"] = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty list when registry absent", async () => {
    const { ok, payload } = await runHandler("tasks.list", {});
    expect(ok).toBe(true);
    expect((payload as { tasks: unknown[] }).tasks).toHaveLength(0);
    expect((payload as { total: number }).total).toBe(0);
  });

  it("returns all tasks with watcherCount", async () => {
    await runHandler("tasks.register", { taskId: "t1", status: "running" });
    await runHandler("tasks.register", { taskId: "t2", status: "done" });
    await runHandler("tasks.watch", { taskId: "t1", sessionKey: "sk1" });
    await runHandler("tasks.watch", { taskId: "t1", sessionKey: "sk2" });

    const { payload } = await runHandler("tasks.list", {});
    const tasks = (payload as { tasks: Array<{ id: string; watcherCount: number }> }).tasks;
    expect(tasks).toHaveLength(2);
    const t1 = tasks.find((t) => t.id === "t1");
    expect(t1?.watcherCount).toBe(2);
  });

  it("filters by status", async () => {
    await runHandler("tasks.register", { taskId: "t1", status: "running" });
    await runHandler("tasks.register", { taskId: "t2", status: "done" });

    const { payload } = await runHandler("tasks.list", { status: "running" });
    const tasks = (payload as { tasks: Array<{ id: string }> }).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("t1");
  });

  it("does not expose watchers array or notifiedEvents in list output", async () => {
    await runHandler("tasks.register", { taskId: "t1" });
    await runHandler("tasks.watch", { taskId: "t1", sessionKey: "sk1" });

    const { payload } = await runHandler("tasks.list", {});
    const tasks = (payload as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks[0]).not.toHaveProperty("watchers");
    expect(tasks[0]).not.toHaveProperty("notifiedEvents");
  });

  it("respects limit param", async () => {
    for (let i = 0; i < 5; i++) {
      await runHandler("tasks.register", { taskId: `t${i}` });
    }
    const { payload } = await runHandler("tasks.list", { limit: 3 });
    expect((payload as { tasks: unknown[] }).tasks).toHaveLength(3);
    expect((payload as { total: number }).total).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// tasks.unwatch handler
// ---------------------------------------------------------------------------

describe("tasks.unwatch", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-unwatch-test-"));
    origHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, ".openclaw"), { recursive: true });
  });
  afterEach(() => {
    process.env["HOME"] = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects missing taskId", async () => {
    const { ok } = await runHandler("tasks.unwatch", { sessionKey: "sk" });
    expect(ok).toBe(false);
  });

  it("rejects missing sessionKey", async () => {
    const { ok } = await runHandler("tasks.unwatch", { taskId: "t1" });
    expect(ok).toBe(false);
  });

  it("removes a watcher and returns updated count", async () => {
    await runHandler("tasks.register", { taskId: "t1" });
    await runHandler("tasks.watch", { taskId: "t1", sessionKey: "sk1" });
    await runHandler("tasks.watch", { taskId: "t1", sessionKey: "sk2" });

    const { ok, payload } = await runHandler("tasks.unwatch", {
      taskId: "t1",
      sessionKey: "sk1",
    });
    expect(ok).toBe(true);
    expect((payload as { watcherCount: number }).watcherCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// tasks.remove handler
// ---------------------------------------------------------------------------

describe("tasks.remove", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-remove-test-"));
    origHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, ".openclaw"), { recursive: true });
  });
  afterEach(() => {
    process.env["HOME"] = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects missing taskId", async () => {
    const { ok } = await runHandler("tasks.remove", {});
    expect(ok).toBe(false);
  });

  it("rejects unknown task", async () => {
    const { ok, error } = await runHandler("tasks.remove", { taskId: "nonexistent" });
    expect(ok).toBe(false);
    expect((error as { message: string }).message).toMatch(/task not found/);
  });

  it("removes the task from the registry", async () => {
    await runHandler("tasks.register", { taskId: "t1" });
    await runHandler("tasks.register", { taskId: "t2" });

    const { ok } = await runHandler("tasks.remove", { taskId: "t1" });
    expect(ok).toBe(true);

    const { payload } = await runHandler("tasks.list", {});
    const tasks = (payload as { tasks: Array<{ id: string }> }).tasks;
    expect(tasks.map((t) => t.id)).toEqual(["t2"]);
  });
});

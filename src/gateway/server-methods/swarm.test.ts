import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWatcherNotificationMessage,
  deliverWatcherNotifications,
  swarmHandlers,
  type SwarmTask,
} from "./swarm.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<SwarmTask> = {}): SwarmTask {
  return {
    id: "agent-task-1234",
    agent: "codex",
    repo: "/repo",
    branch: "agent-task/agent-task-1234",
    worktree: "/tmp/agent-worktrees/agent-task-1234",
    host: "local",
    tmuxSession: "agent-agent-task-1234",
    description: "Fix the login bug",
    startedAt: 1700000000000,
    status: "running",
    ...overrides,
  };
}

function makeRegistry(tasks: SwarmTask[]) {
  return { tasks };
}

function makeRegistryFile(dir: string, tasks: SwarmTask[]): string {
  const file = path.join(dir, "agent-tasks.json");
  fs.writeFileSync(file, JSON.stringify(makeRegistry(tasks), null, 2), "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// buildWatcherNotificationMessage
// ---------------------------------------------------------------------------

describe("buildWatcherNotificationMessage", () => {
  it("includes description and task ID for prCreated", () => {
    const task = makeTask({ pr: 42 });
    const msg = buildWatcherNotificationMessage(task, "prCreated");
    expect(msg).toContain("Fix the login bug");
    expect(msg).toContain("PR: #42");
    expect(msg).toContain("Task ID: agent-task-1234");
    expect(msg).toContain("🔔");
  });

  it("includes description and task ID for completed (done)", () => {
    const task = makeTask({ status: "done", pr: 99, completedAt: 1700000001000 });
    const msg = buildWatcherNotificationMessage(task, "completed");
    expect(msg).toContain("Fix the login bug");
    expect(msg).toContain("PR: #99");
    expect(msg).toContain("Task ID: agent-task-1234");
    expect(msg).toContain("✅");
  });

  it("uses warning emoji for failed status", () => {
    const task = makeTask({ status: "failed", note: "session died" });
    const msg = buildWatcherNotificationMessage(task, "completed");
    expect(msg).toContain("⚠️");
    expect(msg).toContain("Note: session died");
  });

  it("omits PR line when pr field absent", () => {
    const task = makeTask({ status: "done" });
    const msg = buildWatcherNotificationMessage(task, "completed");
    expect(msg).not.toContain("PR:");
  });

  it("omits Note line when note field absent", () => {
    const task = makeTask({ status: "done" });
    const msg = buildWatcherNotificationMessage(task, "completed");
    expect(msg).not.toContain("Note:");
  });
});

// ---------------------------------------------------------------------------
// deliverWatcherNotifications
// ---------------------------------------------------------------------------

describe("deliverWatcherNotifications", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 'no registry' when registry file absent", async () => {
    const sendToSession = vi.fn();
    const result = await deliverWatcherNotifications({
      taskId: "t1",
      event: "prCreated",
      registryPath: path.join(tmpDir, "missing.json"),
      sendToSession,
    });
    expect(result.skipped).toBe("no registry");
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it("returns 'task not found' when taskId absent", async () => {
    const registryPath = makeRegistryFile(tmpDir, [makeTask({ id: "other" })]);
    const sendToSession = vi.fn();
    const result = await deliverWatcherNotifications({
      taskId: "nonexistent",
      event: "prCreated",
      registryPath,
      sendToSession,
    });
    expect(result.skipped).toBe("task not found");
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it("returns 'no watchers' when task has empty watchers", async () => {
    const registryPath = makeRegistryFile(tmpDir, [makeTask({ id: "t1", watchers: [] })]);
    const sendToSession = vi.fn();
    const result = await deliverWatcherNotifications({
      taskId: "t1",
      event: "prCreated",
      registryPath,
      sendToSession,
    });
    expect(result.skipped).toBe("no watchers");
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it("returns 'no watchers' when task has no watchers field", async () => {
    const registryPath = makeRegistryFile(tmpDir, [makeTask({ id: "t1" })]);
    const sendToSession = vi.fn();
    const result = await deliverWatcherNotifications({
      taskId: "t1",
      event: "prCreated",
      registryPath,
      sendToSession,
    });
    expect(result.skipped).toBe("no watchers");
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it("delivers to all session watchers and returns their keys", async () => {
    const registryPath = makeRegistryFile(tmpDir, [
      makeTask({
        id: "t1",
        watchers: [
          { type: "session", sessionKey: "agent:main:main" },
          { type: "session", sessionKey: "agent:main:slack:C123", label: "work" },
        ],
      }),
    ]);
    const sendToSession = vi.fn().mockResolvedValue(undefined);
    const result = await deliverWatcherNotifications({
      taskId: "t1",
      event: "prCreated",
      registryPath,
      sendToSession,
    });
    expect(sendToSession).toHaveBeenCalledTimes(2);
    expect(sendToSession).toHaveBeenCalledWith(
      "agent:main:main",
      expect.stringContaining("Fix the login bug"),
    );
    expect(sendToSession).toHaveBeenCalledWith("agent:main:slack:C123", expect.any(String));
    expect(result.delivered).toEqual(["agent:main:main", "agent:main:slack:C123"]);
    expect(result.skipped).toBe("");
  });

  it("sets notified.prCreated=true in registry after delivery", async () => {
    const registryPath = makeRegistryFile(tmpDir, [
      makeTask({
        id: "t1",
        watchers: [{ type: "session", sessionKey: "agent:main:main" }],
      }),
    ]);
    const sendToSession = vi.fn().mockResolvedValue(undefined);
    await deliverWatcherNotifications({
      taskId: "t1",
      event: "prCreated",
      registryPath,
      sendToSession,
    });

    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const task = updated.tasks.find((t: SwarmTask) => t.id === "t1");
    expect(task.notified?.prCreated).toBe(true);
  });

  it("sets notified.completed=true in registry after delivery", async () => {
    const registryPath = makeRegistryFile(tmpDir, [
      makeTask({
        id: "t1",
        status: "done",
        watchers: [{ type: "session", sessionKey: "agent:main:main" }],
      }),
    ]);
    const sendToSession = vi.fn().mockResolvedValue(undefined);
    await deliverWatcherNotifications({
      taskId: "t1",
      event: "completed",
      registryPath,
      sendToSession,
    });

    const updated = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const task = updated.tasks.find((t: SwarmTask) => t.id === "t1");
    expect(task.notified?.completed).toBe(true);
  });

  it("is idempotent: skips delivery if prCreated already set", async () => {
    const registryPath = makeRegistryFile(tmpDir, [
      makeTask({
        id: "t1",
        watchers: [{ type: "session", sessionKey: "agent:main:main" }],
        notified: { prCreated: true },
      }),
    ]);
    const sendToSession = vi.fn();
    const result = await deliverWatcherNotifications({
      taskId: "t1",
      event: "prCreated",
      registryPath,
      sendToSession,
    });
    expect(sendToSession).not.toHaveBeenCalled();
    expect(result.skipped).toBe("already notified");
  });

  it("is idempotent: skips delivery if completed already set", async () => {
    const registryPath = makeRegistryFile(tmpDir, [
      makeTask({
        id: "t1",
        status: "done",
        watchers: [{ type: "session", sessionKey: "agent:main:main" }],
        notified: { completed: true },
      }),
    ]);
    const sendToSession = vi.fn();
    const result = await deliverWatcherNotifications({
      taskId: "t1",
      event: "completed",
      registryPath,
      sendToSession,
    });
    expect(sendToSession).not.toHaveBeenCalled();
    expect(result.skipped).toBe("already notified");
  });

  it("prCreated idempotency is independent of completed flag", async () => {
    // completed=true should not block prCreated delivery
    const registryPath = makeRegistryFile(tmpDir, [
      makeTask({
        id: "t1",
        pr: 5,
        watchers: [{ type: "session", sessionKey: "agent:main:main" }],
        notified: { completed: true },
      }),
    ]);
    const sendToSession = vi.fn().mockResolvedValue(undefined);
    const result = await deliverWatcherNotifications({
      taskId: "t1",
      event: "prCreated",
      registryPath,
      sendToSession,
    });
    expect(sendToSession).toHaveBeenCalledOnce();
    expect(result.delivered).toHaveLength(1);
  });

  it("continues delivering to remaining watchers if one throws", async () => {
    const registryPath = makeRegistryFile(tmpDir, [
      makeTask({
        id: "t1",
        watchers: [
          { type: "session", sessionKey: "agent:main:bad" },
          { type: "session", sessionKey: "agent:main:good" },
        ],
      }),
    ]);
    const sendToSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("session not found"))
      .mockResolvedValueOnce(undefined);

    const result = await deliverWatcherNotifications({
      taskId: "t1",
      event: "prCreated",
      registryPath,
      sendToSession,
    });
    expect(sendToSession).toHaveBeenCalledTimes(2);
    // Only the successful one is in delivered
    expect(result.delivered).toEqual(["agent:main:good"]);
  });

  it("does not mutate the notified flag when no watchers are delivered", async () => {
    const registryPath = makeRegistryFile(tmpDir, [makeTask({ id: "t1", watchers: [] })]);
    const sendToSession = vi.fn();
    await deliverWatcherNotifications({
      taskId: "t1",
      event: "prCreated",
      registryPath,
      sendToSession,
    });
    const raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const task = raw.tasks.find((t: SwarmTask) => t.id === "t1");
    // notified.prCreated should not be set since nothing was delivered
    expect(task.notified?.prCreated).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// swarm.list — watcherCount field
// ---------------------------------------------------------------------------

describe("swarm.list watcherCount", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-list-test-"));
    origHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    // Create the .openclaw dir
    fs.mkdirSync(path.join(tmpDir, ".openclaw"), { recursive: true });
  });

  afterEach(() => {
    process.env["HOME"] = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runList(statusParam?: string): Promise<{ ok: boolean; payload: unknown }> {
    return new Promise((resolve) => {
      const respond = (ok: boolean, payload: unknown) => {
        resolve({ ok, payload });
      };
      void swarmHandlers["swarm.list"]({
        params: statusParam ? { status: statusParam } : {},
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { id: "r1", type: "req", method: "swarm.list" },
        isWebchatConnect: () => false,
      });
    });
  }

  it("returns watcherCount=0 when task has no watchers", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".openclaw", "agent-tasks.json"),
      JSON.stringify({ tasks: [makeTask({ id: "t1" })] }),
    );
    const { ok, payload } = await runList();
    expect(ok).toBe(true);
    const tasks = (payload as { tasks: Array<{ watcherCount: number }> }).tasks;
    expect(tasks[0]?.watcherCount).toBe(0);
  });

  it("returns watcherCount matching watcher array length", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".openclaw", "agent-tasks.json"),
      JSON.stringify({
        tasks: [
          makeTask({
            id: "t1",
            watchers: [
              { type: "session", sessionKey: "agent:main:main" },
              { type: "session", sessionKey: "agent:main:slack:C123" },
            ],
          }),
        ],
      }),
    );
    const { ok, payload } = await runList();
    expect(ok).toBe(true);
    const tasks = (payload as { tasks: Array<{ watcherCount: number }> }).tasks;
    expect(tasks[0]?.watcherCount).toBe(2);
  });

  it("does not expose watchers array (session keys) in list output", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".openclaw", "agent-tasks.json"),
      JSON.stringify({
        tasks: [
          makeTask({
            id: "t1",
            watchers: [{ type: "session", sessionKey: "agent:main:main" }],
          }),
        ],
      }),
    );
    const { payload } = await runList();
    const tasks = (payload as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks[0]).not.toHaveProperty("watchers");
  });

  it("returns empty tasks array when registry absent", async () => {
    const { ok, payload } = await runList();
    expect(ok).toBe(true);
    expect((payload as { tasks: unknown[] }).tasks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// swarm.notifyWatchers — validation
// ---------------------------------------------------------------------------

describe("swarm.notifyWatchers validation", () => {
  function runNotify(params: Record<string, unknown>): Promise<{ ok: boolean; error?: unknown }> {
    return new Promise((resolve) => {
      // We only test validation here; context.deps is not called for invalid params
      void swarmHandlers["swarm.notifyWatchers"]({
        params,
        respond: (ok, _payload, error) => resolve({ ok, error }),
        context: {} as never,
        client: null,
        req: { id: "r1", type: "req", method: "swarm.notifyWatchers" },
        isWebchatConnect: () => false,
      });
    });
  }

  it("rejects missing taskId", async () => {
    const { ok, error } = await runNotify({ event: "prCreated" });
    expect(ok).toBe(false);
    expect((error as { message: string }).message).toMatch(/taskId/);
  });

  it("rejects missing event", async () => {
    const { ok, error } = await runNotify({ taskId: "t1" });
    expect(ok).toBe(false);
    expect((error as { message: string }).message).toMatch(/event/);
  });

  it("rejects unknown event value", async () => {
    const { ok, error } = await runNotify({ taskId: "t1", event: "bogus" });
    expect(ok).toBe(false);
    expect((error as { message: string }).message).toMatch(/event/);
  });
});

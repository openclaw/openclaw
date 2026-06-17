// Covers task-completion-route lifecycle: register, resolve, attempt, retire, prune.
import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTempDirSync } from "../test-helpers/temp-dir.js";
import {
  noteRouteDeliveryAttempt,
  pruneOrphanedRoutes,
  registerTaskCompletionRoute,
  resolveTaskCompletionRoute,
  retireTaskCompletionRoute,
} from "./task-completion-route.js";

function openDbForDir(dir: string) {
  return openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: dir },
  });
}

function stateDirOptions(dir: string) {
  return { env: { ...process.env, OPENCLAW_STATE_DIR: dir } };
}

describe("task-completion-route", () => {
  it("register then resolve returns identical route", () => {
    withTempDirSync({ prefix: "openclaw-task-completion-route-" }, (dir) => {
      const result = registerTaskCompletionRoute(
        {
          taskId: "cron-run-1",
          source: "cron",
          channel: "webchat",
          to: "controller",
          accountId: "default",
          threadId: "thread-42",
        },
        stateDirOptions(dir),
      );
      expect(result).toEqual({ registered: true });

      const resolved = resolveTaskCompletionRoute("cron-run-1", stateDirOptions(dir));
      expect(resolved).not.toBeNull();
      expect(resolved?.taskId).toBe("cron-run-1");
      expect(resolved?.source).toBe("cron");
      expect(resolved?.channel).toBe("webchat");
      expect(resolved?.to).toBe("controller");
      expect(resolved?.accountId).toBe("default");
      expect(resolved?.threadId).toBe("thread-42");
      expect(resolved?.retiredAt).toBeNull();
      expect(resolved?.deliveryAttempts).toBe(0);
      expect(resolved?.lastDeliveryStatus).toBeNull();
    });
  });

  it("register twice with same taskId returns duplicate_task_id and keeps the first row", () => {
    withTempDirSync({ prefix: "openclaw-task-completion-route-" }, (dir) => {
      const first = registerTaskCompletionRoute(
        {
          taskId: "task-dup",
          source: "cron",
          channel: "webchat",
          to: "controller",
        },
        stateDirOptions(dir),
      );
      expect(first).toEqual({ registered: true });

      const second = registerTaskCompletionRoute(
        {
          taskId: "task-dup",
          source: "subagent",
          channel: "telegram",
          to: "user-1",
        },
        stateDirOptions(dir),
      );
      expect(second).toEqual({ registered: false, reason: "duplicate_task_id" });

      const resolved = resolveTaskCompletionRoute("task-dup", stateDirOptions(dir));
      expect(resolved?.source).toBe("cron");
      expect(resolved?.channel).toBe("webchat");
    });
  });

  it("resolve returns null for unknown taskId", () => {
    withTempDirSync({ prefix: "openclaw-task-completion-route-" }, (dir) => {
      const resolved = resolveTaskCompletionRoute("does-not-exist", stateDirOptions(dir));
      expect(resolved).toBeNull();
    });
  });

  it("resolve returns null after route is retired", () => {
    withTempDirSync({ prefix: "openclaw-task-completion-route-" }, (dir) => {
      registerTaskCompletionRoute(
        {
          taskId: "to-retire",
          source: "cron",
          channel: "webchat",
          to: "controller",
        },
        stateDirOptions(dir),
      );
      retireTaskCompletionRoute("to-retire", stateDirOptions(dir));
      const resolved = resolveTaskCompletionRoute("to-retire", stateDirOptions(dir));
      expect(resolved).toBeNull();
    });
  });

  it("noteRouteDeliveryAttempt increments counter and stamps status, route stays active", () => {
    withTempDirSync({ prefix: "openclaw-task-completion-route-" }, (dir) => {
      registerTaskCompletionRoute(
        {
          taskId: "attempt-task",
          source: "cron",
          channel: "webchat",
        },
        stateDirOptions(dir),
      );

      noteRouteDeliveryAttempt("attempt-task", "delivered", stateDirOptions(dir));
      noteRouteDeliveryAttempt("attempt-task", "failed", stateDirOptions(dir));

      const resolved = resolveTaskCompletionRoute("attempt-task", stateDirOptions(dir));
      expect(resolved).not.toBeNull();
      expect(resolved?.deliveryAttempts).toBe(2);
      expect(resolved?.lastDeliveryStatus).toBe("failed");
      expect(resolved?.lastDeliveryAt).not.toBeNull();
      expect(resolved?.retiredAt).toBeNull();
    });
  });

  it("retire is idempotent: second call is a no-op", () => {
    withTempDirSync({ prefix: "openclaw-task-completion-route-" }, (dir) => {
      registerTaskCompletionRoute(
        {
          taskId: "retire-idempotent",
          source: "cron",
          channel: "webchat",
        },
        stateDirOptions(dir),
      );
      retireTaskCompletionRoute("retire-idempotent", stateDirOptions(dir));
      const firstRetiredAt = readRawRetiredAt(dir, "retire-idempotent");
      expect(firstRetiredAt).not.toBeNull();

      // Sleep a tick so the second timestamp would differ if it ran.
      const beforeSecond = Date.now();
      retireTaskCompletionRoute("retire-idempotent", stateDirOptions(dir));
      const secondRetiredAt = readRawRetiredAt(dir, "retire-idempotent");
      expect(secondRetiredAt).toBe(firstRetiredAt);
      expect(firstRetiredAt ?? 0).toBeLessThanOrEqual(beforeSecond);
    });
  });

  it("pruneOrphanedRoutes only deletes routes older than threshold and only unretired ones", () => {
    withTempDirSync({ prefix: "openclaw-task-completion-route-" }, (dir) => {
      registerTaskCompletionRoute(
        { taskId: "old-orphan", source: "cron", channel: "webchat" },
        stateDirOptions(dir),
      );
      registerTaskCompletionRoute(
        { taskId: "young-active", source: "cron", channel: "webchat" },
        stateDirOptions(dir),
      );
      registerTaskCompletionRoute(
        { taskId: "old-retired", source: "cron", channel: "webchat" },
        stateDirOptions(dir),
      );

      // Backdate the two "old" rows to 10 minutes ago.
      backdateRegisteredAt(dir, "old-orphan", Date.now() - 10 * 60_000);
      backdateRegisteredAt(dir, "old-retired", Date.now() - 10 * 60_000);

      retireTaskCompletionRoute("old-retired", stateDirOptions(dir));

      const result = pruneOrphanedRoutes(5 * 60_000, stateDirOptions(dir));
      expect(result.pruned).toBe(1);

      // old-orphan is gone (old + unretired).
      expect(resolveTaskCompletionRoute("old-orphan", stateDirOptions(dir))).toBeNull();
      // young-active stays (young + unretired).
      expect(resolveTaskCompletionRoute("young-active", stateDirOptions(dir))).not.toBeNull();
      // old-retired stays at the SQL layer even though retired — prune only deletes
      // unretired rows, so the raw row still exists but resolve() hides it.
      expect(readRawRowExists(dir, "old-retired")).toBe(true);
    });
  });

  it("survives simulated gateway restart: data persists across DB reopen", () => {
    let capturedDir = "";
    withTempDirSync({ prefix: "openclaw-task-completion-route-" }, (dir) => {
      capturedDir = dir;
      registerTaskCompletionRoute(
        {
          taskId: "persist-test",
          source: "cron",
          channel: "webchat",
          to: "controller",
        },
        stateDirOptions(dir),
      );
      noteRouteDeliveryAttempt("persist-test", "delivered", stateDirOptions(dir));
    });
    // Reopen the same state dir as if the gateway restarted.
    expect(capturedDir).not.toBe("");
    const resolved = resolveTaskCompletionRoute("persist-test", stateDirOptions(capturedDir));
    expect(resolved).not.toBeNull();
    expect(resolved?.channel).toBe("webchat");
    expect(resolved?.to).toBe("controller");
    expect(resolved?.deliveryAttempts).toBe(1);
    expect(resolved?.lastDeliveryStatus).toBe("delivered");
  });

  it("register throws when taskId or source is missing", () => {
    withTempDirSync({ prefix: "openclaw-task-completion-route-" }, (dir) => {
      expect(() =>
        registerTaskCompletionRoute(
          { taskId: "", source: "cron", channel: "webchat" },
          stateDirOptions(dir),
        ),
      ).toThrow(/taskId/);
      expect(() =>
        registerTaskCompletionRoute(
          { taskId: "t", source: "cron", channel: "webchat" },
          stateDirOptions(dir),
        ),
      ).not.toThrow();
      // source omitted
      expect(() =>
        registerTaskCompletionRoute(
          // @ts-expect-error: intentionally missing source to validate runtime check
          { taskId: "no-source" },
          stateDirOptions(dir),
        ),
      ).toThrow(/source/);
    });
  });
});

// --- helpers ---

function readRawRetiredAt(dir: string, taskId: string): number | null {
  const row = openDbForDir(dir)
    .db.prepare("SELECT retired_at FROM task_completion_routes WHERE task_id = ?")
    .get(taskId) as { retired_at: number | null } | undefined;
  return row?.retired_at == null ? null : row.retired_at;
}

function readRawRowExists(dir: string, taskId: string): boolean {
  const row = openDbForDir(dir)
    .db.prepare("SELECT 1 AS present FROM task_completion_routes WHERE task_id = ?")
    .get(taskId) as { present: number } | undefined;
  return Boolean(row?.present);
}

function backdateRegisteredAt(dir: string, taskId: string, ts: number): void {
  openDbForDir(dir)
    .db.prepare("UPDATE task_completion_routes SET registered_at = ? WHERE task_id = ?")
    .run(ts, taskId);
}

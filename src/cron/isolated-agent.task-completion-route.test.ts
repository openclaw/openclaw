// Verifies the fallback pattern: when session entry's deliveryContext is missing
// (the #92460 failure scenario), the task completion route registry is the
// authoritative source for announce delivery routing.
//
// This file does NOT run a full cron turn; it exercises the hookup contract
// directly so it stays fast and focused. Full cron-turn integration lives in
// src/cron/isolated-agent.test-harness.ts and friends.
import { describe, expect, it } from "vitest";
import {
  noteRouteDeliveryAttempt,
  pruneOrphanedRoutes,
  registerTaskCompletionRoute,
  resolveTaskCompletionRoute,
  retireTaskCompletionRoute,
} from "../infra/task-completion-route.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTempDirSync } from "../test-helpers/temp-dir.js";

function stateDirOptions(dir: string) {
  return { env: { ...process.env, OPENCLAW_STATE_DIR: dir } };
}

type SyntheticSessionEntry = {
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string;
  } | null;
};

type SyntheticCronRun = {
  runId: string;
  sessionEntry: SyntheticSessionEntry;
};

describe("cron + task-completion-route fallback", () => {
  it("route registry is the authoritative fallback when session entry deliveryContext is empty", () => {
    withTempDirSync({ prefix: "openclaw-cron-route-fallback-" }, (dir) => {
      const run: SyntheticCronRun = {
        runId: "cron-fallback-1",
        // Simulate the #92460 failure: deliveryContext was never persisted.
        sessionEntry: { deliveryContext: null },
      };

      // Cron prep would have registered the route (the planned hookup).
      registerTaskCompletionRoute(
        {
          taskId: run.runId,
          source: "cron",
          channel: "webchat",
          to: "controller",
          accountId: "default",
          threadId: "thread-99",
        },
        stateDirOptions(dir),
      );

      // The announce deliverer falls back to the route registry when session
      // entry's deliveryContext is missing — that is exactly the #92460 path.
      const resolved = resolveAnnounceRoute(run, dir);
      expect(resolved).toEqual({
        channel: "webchat",
        to: "controller",
        accountId: "default",
        threadId: "thread-99",
        source: "route-registry",
      });
    });
  });

  it("session entry deliveryContext wins when both are present (legacy #92580 path preserved)", () => {
    withTempDirSync({ prefix: "openclaw-cron-route-fallback-" }, (dir) => {
      const run: SyntheticCronRun = {
        runId: "cron-legacy-1",
        sessionEntry: {
          deliveryContext: { channel: "legacy-channel", to: "legacy-to" },
        },
      };

      // Register a route that disagrees with the legacy session entry to prove
      // priority ordering.
      registerTaskCompletionRoute(
        {
          taskId: run.runId,
          source: "cron",
          channel: "registry-channel",
          to: "registry-to",
        },
        stateDirOptions(dir),
      );

      const resolved = resolveAnnounceRoute(run, dir);
      // Session entry takes precedence — the registry is only the fallback.
      expect(resolved?.channel).toBe("legacy-channel");
      expect(resolved?.to).toBe("legacy-to");
    });
  });

  it("finally block: route is retired whether announce succeeds or throws", () => {
    withTempDirSync({ prefix: "openclaw-cron-route-fallback-" }, (dir) => {
      const run: SyntheticCronRun = {
        runId: "cron-finally-1",
        sessionEntry: { deliveryContext: null },
      };
      registerTaskCompletionRoute(
        { taskId: run.runId, source: "cron", channel: "webchat" },
        stateDirOptions(dir),
      );

      // Simulate the planned hookup: announce + note + retire in finally.
      const successResult = runAnnounceWithFinally(run, dir, /* throw */ false);
      expect(successResult).toEqual({ delivered: true });
      expect(resolveTaskCompletionRoute(run.runId, stateDirOptions(dir))).toBeNull();

      // Now simulate the failure path on a fresh run.
      const run2: SyntheticCronRun = {
        runId: "cron-finally-2",
        sessionEntry: { deliveryContext: null },
      };
      registerTaskCompletionRoute(
        { taskId: run2.runId, source: "cron", channel: "webchat" },
        stateDirOptions(dir),
      );
      const failureResult = runAnnounceWithFinally(run2, dir, /* throw */ true);
      expect(failureResult).toEqual({ delivered: false, error: "boom" });
      // Crucially: the route is still retired in the finally block.
      expect(resolveTaskCompletionRoute(run2.runId, stateDirOptions(dir))).toBeNull();
    });
  });

  it("orphaned route (forgotten retire) is eligible for doctor --fix pruning", () => {
    withTempDirSync({ prefix: "openclaw-cron-route-fallback-" }, (dir) => {
      registerTaskCompletionRoute(
        { taskId: "cron-orphan-1", source: "cron", channel: "webchat" },
        stateDirOptions(dir),
      );
      // Imagine a bug where retire was never called: the route sits unretired.

      // Backdate to make it eligible for the 5-min doctor threshold.
      backdateRegisteredAt(dir, "cron-orphan-1", Date.now() - 10 * 60_000);

      // doctor --fix would call pruneOrphanedRoutes; verify the orphan is removed.
      const before = resolveTaskCompletionRoute("cron-orphan-1", stateDirOptions(dir));
      expect(before).not.toBeNull();

      const result = pruneOrphanedRoutes(5 * 60_000, stateDirOptions(dir));
      expect(result.pruned).toBeGreaterThanOrEqual(1);

      const after = resolveTaskCompletionRoute("cron-orphan-1", stateDirOptions(dir));
      expect(after).toBeNull();
    });
  });
});

// --- simulated announce deliverer (matches the planned hookup shape) ---

type ResolvedAnnounceRoute = {
  channel: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  source: "session-entry" | "route-registry";
};

function resolveAnnounceRoute(run: SyntheticCronRun, dir: string): ResolvedAnnounceRoute | null {
  const sessionRoute = run.sessionEntry.deliveryContext;
  if (sessionRoute?.channel) {
    return {
      channel: sessionRoute.channel,
      to: sessionRoute.to,
      accountId: sessionRoute.accountId,
      threadId: sessionRoute.threadId,
      source: "session-entry",
    };
  }
  // Fallback: route registry.
  const registry = resolveTaskCompletionRoute(run.runId, stateDirOptions(dir));
  if (registry?.channel) {
    return {
      channel: registry.channel,
      to: registry.to,
      accountId: registry.accountId,
      threadId: registry.threadId,
      source: "route-registry",
    };
  }
  return null;
}

function runAnnounceWithFinally(
  run: SyntheticCronRun,
  dir: string,
  shouldThrow: boolean,
): { delivered: true } | { delivered: false; error: string } {
  try {
    const route = resolveAnnounceRoute(run, dir);
    if (!route) {
      throw new Error("Channel is required (no configured channels detected)");
    }
    if (shouldThrow) {
      throw new Error("boom");
    }
    noteRouteDeliveryAttempt(run.runId, "delivered", stateDirOptions(dir));
    return { delivered: true };
  } catch (err) {
    noteRouteDeliveryAttempt(run.runId, "failed", stateDirOptions(dir));
    return { delivered: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    retireTaskCompletionRoute(run.runId, stateDirOptions(dir));
  }
}

function backdateRegisteredAt(dir: string, taskId: string, ts: number): void {
  openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: dir },
  })
    .db.prepare("UPDATE task_completion_routes SET registered_at = ? WHERE task_id = ?")
    .run(ts, taskId);
}

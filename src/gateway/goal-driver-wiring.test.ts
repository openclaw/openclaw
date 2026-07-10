// Gateway wiring + safety tests for the autonomous goal continuation driver.
//
// Drives startGoalDriverWiring against a REAL temp session store, the real
// system-event queue, and the real heartbeat-wake path (fake timers). Covers:
//  - the experiment flag gate (disabled -> no wiring),
//  - arm-on-turn-completed -> fire a continuation onto the system-event queue
//    together with a heartbeat wake (enqueue-alone would strand the event),
//  - auto-pause at the no-progress ceiling emits a durable goal.updated event,
//  - SAFETY: a driver-continued turn never bypasses the exec-approval gate.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isGoalDriverContinuationPrompt } from "../agents/goal-driver/continuation-prompt.js";
import { getSessionEntry, upsertSessionEntry } from "../config/sessions.js";
import { setGoalUpdatedEmitter } from "../config/sessions/goal-events.js";
import type { SessionGoal } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasPendingHeartbeatWake,
  resetHeartbeatWakeStateForTests,
} from "../infra/heartbeat-wake.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import type { QueuedChatTurnMap } from "./chat-queued-turns.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { bindGoalUpdatedBroadcast, startGoalDriverWiring } from "./goal-driver-wiring.js";

const DEBOUNCE_MS = 20_000;
const sessionKey = "agent:main:web:main";

let tempRoots: string[] = [];

async function createStorePath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-goal-driver-wiring-"));
  tempRoots.push(root);
  return path.join(root, "sessions.json");
}

function buildConfig(storePath: string, enabled: boolean): OpenClawConfig {
  return {
    session: { store: storePath },
    tools: {
      experimental: {
        goalDriver: { enabled, debounceMs: DEBOUNCE_MS, jitterMs: 0 },
      },
    },
  } as unknown as OpenClawConfig;
}

async function writeGoal(storePath: string, goal: Partial<SessionGoal>): Promise<void> {
  await upsertSessionEntry({
    storePath,
    sessionKey,
    entry: {
      sessionId: "sess-main",
      updatedAt: 1,
      totalTokens: 0,
      totalTokensFresh: true,
      goal: {
        schemaVersion: 1,
        id: "goal-1",
        objective: "finish the migration",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        tokenStart: 0,
        tokenStartFresh: true,
        tokensUsed: 0,
        continuationTurns: 0,
        ...goal,
      },
    },
  });
}

function makeBroadcastSpy() {
  const events: Array<{ event: string; payload: unknown }> = [];
  return {
    events,
    broadcast: (event: string, payload: unknown) => {
      events.push({ event, payload });
    },
  };
}

/** Polls a predicate under real timers until it holds or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: predicate did not become true in time");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSystemEventsForTest();
  resetHeartbeatWakeStateForTests();
});

afterEach(async () => {
  setGoalUpdatedEmitter(null);
  resetSystemEventsForTest();
  resetHeartbeatWakeStateForTests();
  vi.clearAllTimers();
  vi.useRealTimers();
  // Let any fire-and-forget store writes settle before removing the temp dir so
  // a late lockfile write cannot race the rmdir (ENOTEMPTY).
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  await Promise.all(
    tempRoots.map((root) =>
      fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
    ),
  );
  tempRoots = [];
});

describe("startGoalDriverWiring", () => {
  it("returns undefined when the goalDriver flag is off", async () => {
    const storePath = await createStorePath();
    await writeGoal(storePath, {});
    const wiring = startGoalDriverWiring({
      config: buildConfig(storePath, false),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map() as QueuedChatTurnMap,
    });
    expect(wiring).toBeUndefined();
  });

  it("fires a continuation onto the system-event queue AND requests a heartbeat wake", async () => {
    const storePath = await createStorePath();
    await writeGoal(storePath, {});

    const wiring = startGoalDriverWiring({
      config: buildConfig(storePath, true),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map() as QueuedChatTurnMap,
    });
    expect(wiring).toBeDefined();

    wiring!.onTurnCompleted(sessionKey);
    vi.advanceTimersByTime(DEBOUNCE_MS + 1);

    const events = peekSystemEvents(sessionKey);
    expect(events).toHaveLength(1);
    expect(isGoalDriverContinuationPrompt(events[0])).toBe(true);
    expect(events[0]).toContain("finish the migration");
    // Enqueue alone strands the event; the driver must also wake a turn.
    expect(hasPendingHeartbeatWake()).toBe(true);

    wiring!.stop();
  });

  it("auto-pauses at the no-progress ceiling and broadcasts a durable goal.updated", async () => {
    // Real timers: the auto-pause path performs an async store write (fs I/O)
    // whose completion fake timers do not deterministically flush.
    vi.useRealTimers();
    const storePath = await createStorePath();
    // Seed the counter at the default ceiling so the first wake auto-pauses.
    await writeGoal(storePath, { continuationTurns: 3 });
    const { events, broadcast } = makeBroadcastSpy();
    // The driver's auto-pause writes through updateSessionGoalStatus, which emits
    // via the global goal-events emitter -> goal.updated broadcast.
    bindGoalUpdatedBroadcast(broadcast);

    const wiring = startGoalDriverWiring({
      config: {
        ...buildConfig(storePath, true),
        tools: { experimental: { goalDriver: { enabled: true, debounceMs: 10, jitterMs: 0 } } },
      } as OpenClawConfig,
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map() as QueuedChatTurnMap,
    });
    // No onTurnCompleted call: the startup rearm arms the persisted active goal
    // WITHOUT resetting the counter (a real inbound turn would reset it), so the
    // seeded ceiling trips on the first wake.

    // A goal.updated event is broadcast for the auto-pause. The driver's arm
    // delay is floored at minRearmGapMs (2s), so allow >2s here.
    await waitFor(() => events.some((e) => e.event === "goal.updated"), 9_000);
    const goalUpdated = events.find((e) => e.event === "goal.updated");
    expect(goalUpdated?.payload).toMatchObject({ status: "paused" });
    // No continuation fired (ceiling hit before FIRE).
    expect(peekSystemEvents(sessionKey)).toHaveLength(0);
    // The pause is durable (survives restart / re-read).
    await waitFor(
      () => getSessionEntry({ storePath, sessionKey })?.goal?.status === "paused",
      9_000,
    );
    expect(getSessionEntry({ storePath, sessionKey })?.goal?.status).toBe("paused");

    wiring!.stop();
  });

  it("SAFETY: a driver-continued turn does not bypass the exec-approval gate", async () => {
    const storePath = await createStorePath();
    await writeGoal(storePath, {});

    const wiring = startGoalDriverWiring({
      config: buildConfig(storePath, true),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map() as QueuedChatTurnMap,
    });

    // Fire a driver continuation for the session (starts an autonomous turn).
    wiring!.onTurnCompleted(sessionKey);
    vi.advanceTimersByTime(DEBOUNCE_MS + 1);
    expect(peekSystemEvents(sessionKey)).toHaveLength(1);

    // An exec inside that continued turn registers a normal approval request.
    const approvals = new ExecApprovalManager<{ command: string }>();
    const record = approvals.create({ command: "rm -rf /tmp/x" }, 60_000);
    const decisionPromise = approvals.register(record, 60_000);

    // The goal continuation confers NO auto-decision: the request stays pending,
    // exactly like any other turn. It only resolves when an operator decides.
    expect(approvals.listPendingRecords()).toHaveLength(1);
    const pendingSentinel = Symbol("pending");
    const raced = await Promise.race([decisionPromise, Promise.resolve(pendingSentinel)]);
    expect(raced).toBe(pendingSentinel);

    // Once (and only once) the operator resolves it, the gate releases.
    approvals.resolve(record.id, "allow-once");
    await expect(decisionPromise).resolves.toBe("allow-once");

    wiring!.stop();
  });
});

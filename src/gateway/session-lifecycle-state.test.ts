/**
 * Session lifecycle state derivation tests.
 */
import { describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";

const persistenceMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  updateSessionEntry: vi.fn(),
}));
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

// Lifecycle projection formats stored failures without initializing provider runtime.
vi.mock("../plugins/loader-runtime-load.js", () => {
  throw new Error("Session lifecycle presentation imported plugin runtime ownership");
});

vi.mock("../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: persistenceMocks.updateSessionEntry,
  appendSessionTranscriptReport: vi.fn(async () => ({ ok: true, value: undefined })),
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: persistenceMocks.loadSessionEntry,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => loggerMocks,
}));

import {
  deriveGatewaySessionLifecycleProjectionPatch,
  isStaleLifecycleEventForSession,
  persistGatewaySessionLifecycleEvent,
} from "./session-lifecycle-state.js";
import {
  persistLifecycleThroughMockedStore,
  type LifecycleEvent,
  type UpdateSessionEntry,
} from "./session-lifecycle-state.test-support.js";

const exactCronSessionKey = "agent:main:cron:job-1:run:cron-run-1";

function cronSessionEntry(
  phase: "running" | "ready" | "continuing",
  ownerRunId?: string,
): SessionEntry {
  return {
    sessionId: "cron-session-id",
    updatedAt: 1_000,
    status: "running",
    cronRunContinuation: {
      lifecycleRevision: "revision-1",
      phase,
      ...(ownerRunId ? { ownerRunId } : {}),
    },
  };
}

function persistLifecycle(
  entry: SessionEntry,
  event: LifecycleEvent,
  sessionKey = "agent:main:main",
): Promise<SessionEntry> {
  return persistLifecycleThroughMockedStore(persistenceMocks, { sessionKey, entry, event });
}

describe("session lifecycle state", () => {
  const goalEntry: SessionEntry = {
    sessionId: "goal-session",
    updatedAt: 1_000,
    startedAt: 1_000,
    status: "running",
    lifecycleRunId: "goal-run",
    goal: {
      schemaVersion: 1,
      id: "goal-1",
      objective: "Finish the work",
      status: "active",
      createdAt: 1_000,
      updatedAt: 1_000,
      tokenStart: 0,
      tokensUsed: 12,
      continuationTurns: 0,
    },
  };
  const goalFailure: LifecycleEvent = {
    sessionId: "goal-session",
    runId: "goal-run",
    ts: 2_000,
    data: {
      phase: "error",
      startedAt: 1_000,
      endedAt: 2_000,
      error: "stream disconnected before completion",
    },
  };

  it.each([
    { phase: "error", stopReason: undefined, status: "failed" },
    { phase: "end", stopReason: "error", status: "failed" },
    { phase: "end", stopReason: "timeout", status: "timeout" },
  ])("pauses an active goal when its run settles as $status via $phase", async (terminal) => {
    const stopped = await persistLifecycle(goalEntry, {
      ...goalFailure,
      data: { ...goalFailure.data, phase: terminal.phase, stopReason: terminal.stopReason },
    });
    expect(stopped.status).toBe(terminal.status);
    expect(stopped.goal).toMatchObject({
      id: "goal-1",
      objective: "Finish the work",
      status: "paused",
      pausedAt: 2_000,
      updatedAt: 2_000,
      tokensUsed: 12,
      lastStatusNote: expect.stringContaining("stream disconnected before completion"),
    });
    const next = await persistLifecycle(stopped, {
      ...goalFailure,
      runId: "next-run",
      ts: 3_000,
      data: { phase: "start", startedAt: 3_000 },
    });
    expect(next.goal).toEqual(stopped.goal);
  });

  it.each(["paused", "blocked", "complete", "budget_limited", "usage_limited"] as const)(
    "preserves an already %s goal on run failure",
    async (status) => {
      const entry = { ...goalEntry, goal: { ...goalEntry.goal!, status } };
      expect((await persistLifecycle(entry, goalFailure)).goal).toEqual(entry.goal);
    },
  );

  it.each([
    { phase: "start", startedAt: 1_000 },
    { phase: "end", endedAt: 2_000 },
    { phase: "end", yielded: true, livenessState: "waiting", endedAt: 2_000 },
    { phase: "error", aborted: true, stopReason: "restart", endedAt: 2_000 },
  ])("keeps the goal active for non-failure lifecycle $phase / $stopReason", async (data) => {
    expect((await persistLifecycle(goalEntry, { ...goalFailure, data })).goal).toEqual(
      goalEntry.goal,
    );
  });

  it("does not pause the goal for a stale run or session failure", async () => {
    for (const event of [
      { ...goalFailure, sessionId: "old-session" },
      { ...goalFailure, runId: "old-run", data: { ...goalFailure.data, startedAt: 500 } },
    ]) {
      expect((await persistLifecycle(goalEntry, event)).goal).toEqual(goalEntry.goal);
    }
  });

  it.each(["goal-1", "replacement-goal"])(
    "preserves newer goal intent for %s when a terminal write is delayed",
    async (id) => {
      const entry = {
        ...goalEntry,
        lifecycleRunId: undefined,
        goal: { ...goalEntry.goal!, id, updatedAt: 3_000 },
      };
      expect((await persistLifecycle(entry, goalFailure)).goal).toEqual(entry.goal);
    },
  );

  it("treats a pre-reset run's lifecycle event as stale once the row's sessionId rotated (#88538)", () => {
    expect(
      isStaleLifecycleEventForSession({
        owningSessionId: "old-id",
        currentSessionId: "new-id",
        eventRunId: "same-run",
        currentRunId: "same-run",
      }),
    ).toBe(true);
  });

  it("does not guard when the owning sessionId is unknown (preserves legacy behavior)", () => {
    expect(
      isStaleLifecycleEventForSession({ owningSessionId: undefined, currentSessionId: "new-id" }),
    ).toBe(false);
  });

  it.each([
    { eventRunId: undefined, currentRunId: undefined, eventStartedAt: 100, stale: true },
    { eventRunId: "run-a", currentRunId: undefined, eventStartedAt: 100, stale: true },
    { eventRunId: undefined, currentRunId: "run-a", eventStartedAt: 100, stale: true },
    { eventRunId: undefined, currentRunId: undefined, eventStartedAt: 200, stale: false },
    { eventRunId: undefined, currentRunId: undefined, eventStartedAt: 300, stale: false },
    { eventRunId: undefined, currentRunId: undefined, eventStartedAt: undefined, stale: false },
    { eventRunId: undefined, currentRunId: undefined, eventStartedAt: Number.NaN, stale: false },
  ])(
    "correlates explicit same-session run start times",
    ({ eventRunId, currentRunId, eventStartedAt, stale }) => {
      expect(
        isStaleLifecycleEventForSession({
          owningSessionId: "session-id",
          currentSessionId: "session-id",
          eventRunId,
          currentRunId,
          eventStartedAt,
          currentStartedAt: 200,
        }),
      ).toBe(stale);
    },
  );

  it.each(["end", "error"] as const)(
    "ignores an older overlapping run's late %s while preserving the newer owner",
    async (phase) => {
      const first = await persistLifecycle(
        { sessionId: "session-id", updatedAt: 900 },
        {
          ts: 1_000,
          sessionId: "session-id",
          runId: "run-a",
          data: { phase: "start", startedAt: 1_000 },
        },
      );
      const second = await persistLifecycle(first, {
        ts: 2_000,
        sessionId: "session-id",
        runId: "run-b",
        data: { phase: "start", startedAt: 2_000 },
      });
      expect(second.lifecycleRunId).toBe("run-b");
      const afterOlderTerminal = await persistLifecycle(second, {
        ts: 3_000,
        sessionId: "session-id",
        runId: "run-a",
        data: {
          phase,
          startedAt: 1_000,
          endedAt: 3_000,
          ...(phase === "error" ? { error: "older run failed" } : {}),
        },
      });

      expect(afterOlderTerminal).toMatchObject({ status: "running", startedAt: 2_000 });
      expect(afterOlderTerminal.lifecycleRunId).toBe("run-b");
      expect(afterOlderTerminal.endedAt).toBeUndefined();
      expect(afterOlderTerminal.lastRunError).toBeUndefined();

      const completed = await persistLifecycle(afterOlderTerminal, {
        ts: 4_000,
        sessionId: "session-id",
        runId: "run-b",
        data: { phase: "end", startedAt: 2_000, endedAt: 4_000 },
      });
      expect(completed).toMatchObject({
        status: "done",
        startedAt: 2_000,
        endedAt: 4_000,
        runtimeMs: 2_000,
      });
      expect(completed.lifecycleRunId).toBeUndefined();
      expect(completed.lastRunId).toBe("run-b");
    },
  );

  it("settles a same-run terminal event whose outer start time predates its embedded start", async () => {
    const started = await persistLifecycle(
      { sessionId: "session-id", updatedAt: 900 },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "run-a",
        data: { phase: "start", startedAt: 2_000 },
      },
    );
    const completed = await persistLifecycle(started, {
      ts: 3_000,
      sessionId: "session-id",
      runId: "run-a",
      data: { phase: "end", startedAt: 1_900, endedAt: 3_000 },
    });

    expect(completed).toMatchObject({
      status: "done",
      startedAt: 1_900,
      endedAt: 3_000,
      runtimeMs: 1_100,
    });
    expect(completed.lifecycleRunId).toBeUndefined();
  });

  it("does not reopen a terminal row when its same-run start persistence arrives late", async () => {
    const completed = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 2_000,
        status: "done",
        startedAt: 1_000,
        endedAt: 2_000,
        runtimeMs: 1_000,
        lastRunId: "run-a",
      },
      {
        ts: 2_100,
        sessionId: "session-id",
        runId: "run-a",
        data: { phase: "start", startedAt: 1_000 },
      },
    );

    expect(completed).toMatchObject({
      status: "done",
      endedAt: 2_000,
      lastRunId: "run-a",
    });
  });

  it("keeps provider lifecycle ownership while recording the client terminal run", async () => {
    const started = await persistLifecycle(
      { sessionId: "session-id", updatedAt: 900 },
      {
        ts: 1_000,
        sessionId: "session-id",
        runId: "provider-run",
        clientRunId: "client-run",
        data: { phase: "start", startedAt: 1_000 },
      },
    );
    expect(started.lifecycleRunId).toBe("provider-run");

    const completed = await persistLifecycle(started, {
      ts: 2_000,
      sessionId: "session-id",
      runId: "provider-run",
      clientRunId: "client-run",
      data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
    });

    expect(completed.lifecycleRunId).toBeUndefined();
    expect(completed.lastRunId).toBe("client-run");
  });

  it("clears inherited run ownership when a start event has no run id", async () => {
    const started = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 900,
        status: "running",
        startedAt: 900,
        lifecycleRunId: "old-run",
        lastRunId: "old-run",
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        data: { phase: "start", startedAt: 2_000 },
      },
    );

    expect(started.lifecycleRunId).toBeUndefined();
    expect(started.lastRunId).toBeUndefined();
  });

  it.each([
    {
      name: "aborted",
      data: { phase: "end", endedAt: 1_800, stopReason: "aborted" },
      status: "killed",
      abortedLastRun: true,
    },
    {
      name: "signal-only cancellation",
      data: { phase: "end", endedAt: 1_800, aborted: true },
      status: "killed",
      abortedLastRun: true,
    },
    {
      name: "provider timeout",
      data: {
        phase: "error",
        endedAt: 1_800,
        error: "provider request timed out",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      status: "timeout",
      abortedLastRun: false,
    },
    {
      name: "abandoned",
      data: { phase: "end", endedAt: 1_800, livenessState: "abandoned" },
      status: "failed",
      abortedLastRun: false,
    },
    {
      name: "error with stale yield metadata",
      data: {
        phase: "error",
        endedAt: 1_800,
        error: "continuation setup failed",
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
      },
      status: "failed",
      abortedLastRun: false,
    },
    {
      name: "aborted with stale yield metadata",
      data: {
        phase: "end",
        endedAt: 1_800,
        aborted: true,
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
      },
      status: "failed",
      abortedLastRun: false,
    },
  ] as const)("persists $name terminal state", async ({ data, status, abortedLastRun }) => {
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
      },
      { ts: 2_000, sessionId: "session-id", data },
    );

    expect(persisted).toMatchObject({
      status,
      startedAt: 1_050,
      endedAt: 1_800,
      runtimeMs: 750,
      abortedLastRun,
    });
  });

  it.each([
    { name: "visible run", controlUiVisible: true, isHeartbeat: false, lastActivityAt: 1_800 },
    { name: "heartbeat", controlUiVisible: true, isHeartbeat: true, lastActivityAt: 1_000 },
    { name: "hidden run", controlUiVisible: false, isHeartbeat: false, lastActivityAt: 1_000 },
  ])(
    "records unread-worthy completion activity for a $name",
    async ({ controlUiVisible, isHeartbeat, lastActivityAt }) => {
      const persisted = await persistLifecycle(
        {
          sessionId: "session-id",
          updatedAt: 1_000,
          lastActivityAt: 1_000,
          startedAt: 1_050,
          status: "running",
        },
        {
          ts: 2_000,
          sessionId: "session-id",
          controlUiVisible,
          isHeartbeat,
          data: { phase: "end", endedAt: 1_800 },
        },
      );

      expect(persisted.lastActivityAt).toBe(lastActivityAt);
    },
  );

  it("persists a compact failure reason and clears it when a new run starts", async () => {
    const failed = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        data: {
          phase: "error",
          endedAt: 1_800,
          error: `Provider credits exhausted\n${"details ".repeat(40)}`,
        },
      },
    );

    expect(failed.status).toBe("failed");
    expect(failed.lastRunError).toMatch(/^Provider credits exhausted details/);
    expect(failed.lastRunError?.length).toBeLessThanOrEqual(160);
    expect(failed.lastRunError).not.toContain("\n");

    const restarted = await persistLifecycle(failed, {
      ts: 2_100,
      sessionId: "session-id",
      data: { phase: "start", startedAt: 2_100 },
    });
    expect(restarted.status).toBe("running");
    expect(restarted.lastRunError).toBeUndefined();
  });

  it("keeps an explicitly yielded parent pending until continuation starts", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    loggerMocks.info.mockClear();
    loggerMocks.warn.mockClear();
    const yielded = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "yielded-recovery-run",
        lifecycleGeneration,
        mainSessionRestartRecovery: true,
        data: {
          phase: "end",
          endedAt: 1_800,
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
        },
      },
    );

    expect(yielded).toMatchObject({
      status: "running",
      endedAt: 1_800,
      runtimeMs: 750,
      abortedLastRun: false,
    });
    expect(loggerMocks.info).not.toHaveBeenCalled();
    expect(loggerMocks.warn).not.toHaveBeenCalled();

    const resumed = await persistLifecycle(yielded, {
      ts: 2_100,
      sessionId: "session-id",
      data: { phase: "start", startedAt: 2_100 },
    });
    expect(resumed.status).toBe("running");
    expect(resumed.endedAt).toBeUndefined();
  });

  it("does not infer pending continuation from end_turn without explicit yield metadata", async () => {
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        data: {
          phase: "end",
          endedAt: 1_800,
          livenessState: "paused",
          stopReason: "end_turn",
        },
      },
    );

    expect(persisted.status).toBe("done");
  });

  it.each([
    {
      name: "accepts the initial owner while running",
      entry: cronSessionEntry("running"),
      eventRunId: "initial-run",
      eventSessionId: "cron-session-id",
      expectedStatus: "done",
    },
    {
      name: "accepts the active continuation owner",
      entry: cronSessionEntry("continuing", "continuation-run"),
      eventRunId: "continuation-run",
      eventSessionId: "cron-session-id",
      expectedStatus: "done",
    },
    {
      name: "ignores events once ready",
      entry: cronSessionEntry("ready"),
      eventRunId: "continuation-run",
      eventSessionId: "cron-session-id",
      expectedStatus: "running",
    },
    {
      name: "ignores a stale continuation owner",
      entry: cronSessionEntry("continuing", "current-owner"),
      eventRunId: "stale-owner",
      eventSessionId: "cron-session-id",
      expectedStatus: "running",
    },
    {
      name: "ignores a stale session id",
      entry: cronSessionEntry("continuing", "continuation-run"),
      eventRunId: "continuation-run",
      eventSessionId: "stale-session-id",
      expectedStatus: "running",
    },
  ])("direct persistence $name", async (testCase) => {
    const persisted = await persistLifecycle(
      testCase.entry,
      {
        ts: 2_000,
        sessionId: testCase.eventSessionId ?? "cron-session-id",
        runId: testCase.eventRunId,
        data: { phase: "end", startedAt: 1_300, endedAt: 1_950 },
      },
      exactCronSessionKey,
    );

    expect(persisted?.status).toBe(testCase.expectedStatus);
    // One exact-row write only. Continuation settlement owns base projection.
    expect(persistenceMocks.updateSessionEntry).toHaveBeenCalledTimes(1);
    expect(persistenceMocks.updateSessionEntry.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: exactCronSessionKey,
    });
    expect(persistenceMocks.updateSessionEntry.mock.calls[0]?.[2]).toMatchObject({
      requireWriteSuccess: true,
    });
  });

  it("checks terminal authority before committing the session patch", async () => {
    const entry: SessionEntry = {
      sessionId: "terminal-authority-session",
      updatedAt: 1_000,
      startedAt: 1_000,
      status: "running",
      lifecycleRunId: "terminal-authority-run",
    };
    let storedEntry = structuredClone(entry);
    persistenceMocks.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:terminal-authority",
      entry,
    });
    persistenceMocks.updateSessionEntry.mockImplementation(
      async (...args: Parameters<UpdateSessionEntry>) => {
        const [, update, options] = args;
        const patch = await update(structuredClone(storedEntry), {
          existingEntry: structuredClone(storedEntry),
        });
        options?.assertCommitAllowed?.();
        if (patch) {
          storedEntry = { ...storedEntry, ...patch };
        }
        return storedEntry;
      },
    );

    await expect(
      persistGatewaySessionLifecycleEvent({
        sessionKey: "agent:main:terminal-authority",
        event: {
          runId: "terminal-authority-run",
          sessionId: entry.sessionId,
          ts: 2_000,
          data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
        },
        assertCommitAllowed: () => {
          throw new Error("terminal authority retired");
        },
      }),
    ).rejects.toThrow("terminal authority retired");
    expect(storedEntry.status).toBe("running");
  });
});

it("keeps a suppressed lifecycle projection empty while preserving intentional field clears", () => {
  const current: SessionEntry = {
    sessionId: "projection-recovery",
    updatedAt: 1_000,
    startedAt: 900,
    status: "running",
    lifecycleRunId: "foreground-run",
    abortedLastRun: true,
    restartRecoveryRuns: [{ runId: "restart-run", lifecycleGeneration: "pre-restart" }],
    mainRestartRecovery: { cycleId: "cycle-1", revision: 2, chargedAttempts: 2 },
  };
  const suppressed = deriveGatewaySessionLifecycleProjectionPatch({
    entry: current,
    event: { ts: 2_000, sessionId: current.sessionId, data: { phase: "end", endedAt: 1_800 } },
  });
  expect({ ...current, ...suppressed }).toStrictEqual(current);
  expect(suppressed).toStrictEqual({});

  const next = deriveGatewaySessionLifecycleProjectionPatch({
    entry: { status: "done", endedAt: 1_800, runtimeMs: 900 },
    event: { ts: 2_100, runId: "new-run", data: { phase: "start", startedAt: 2_100 } },
  });
  expect(next.status).toBe("running");
  expect(Object.hasOwn(next, "endedAt")).toBe(true);
  expect(Object.hasOwn(next, "runtimeMs")).toBe(true);
  expect({ endedAt: 1_800, runtimeMs: 900, ...next }).toMatchObject({
    endedAt: undefined,
    runtimeMs: undefined,
  });
});

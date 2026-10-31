import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import {
  isStaleLifecycleEventForSession,
  projectSessionLifecyclePatch,
  type SessionLifecyclePatchInput,
} from "../config/sessions/session-run-lifecycle-projection.js";
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

// mock-isolation: Exercise lifecycle reducers without native persistence or transcript writes.
vi.mock("../config/sessions/session-accessor.js", () => ({
  appendSessionTranscriptReport: vi.fn(async () => ({ ok: true, value: undefined })),
}));

// mock-isolation: Exercise the lifecycle reducer without opening the session database.
vi.mock("../config/sessions/session-accessor.sqlite-entry.js", () => ({
  applySessionEntryTargetOperation: persistenceMocks.updateSessionEntry,
}));

// mock-isolation: Controlled entries isolate lifecycle projection from database admission.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async (...args: unknown[]) =>
    persistenceMocks.loadSessionEntry(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => loggerMocks,
}));

import { createSessionGoalFixture } from "./session-goal.test-support.js";
import { deriveGatewaySessionLifecycleProjectionPatch } from "./session-lifecycle-projection.js";
import {
  persistLifecycleThroughMockedStore,
  type LifecycleEvent,
} from "./session-lifecycle-state.test-support.js";

const exactCronSessionKey = "agent:main:cron:job-1:run:cron-run-1";
const runningEntry: SessionEntry = { sessionId: "session-id", updatedAt: 1_000, startedAt: 1_050 };
const freshEntry: SessionEntry = { sessionId: "session-id", updatedAt: 900 };

function lifecycleEvent(
  data: LifecycleEvent["data"],
  overrides: Partial<Omit<LifecycleEvent, "data">> = {},
): LifecycleEvent {
  return { ts: 2_000, sessionId: "session-id", ...overrides, data };
}

function startEvent(startedAt: number, runId?: string) {
  return lifecycleEvent({ phase: "start", startedAt }, { ts: startedAt, runId });
}

function terminalCase(
  name: string,
  data: LifecycleEvent["data"],
  status = "failed",
  abortedLastRun = false,
) {
  return { name, data: { ...data, endedAt: 1_800 }, status, abortedLastRun };
}

function cronCase(
  name: string,
  entry: SessionEntry,
  overrides: { runId?: string; sessionId?: string; expectedStatus?: string } = {},
) {
  return { name, entry, runId: "continuation-run", sessionId: "cron-session-id", ...overrides };
}

function cronSessionEntry(
  phase: "running" | "ready" | "continuing",
  ownerRunId?: string,
): SessionEntry {
  return {
    sessionId: "cron-session-id",
    updatedAt: 1_000,
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
  clientRunId?: string,
): Promise<SessionEntry> {
  return persistLifecycleThroughMockedStore(persistenceMocks, {
    sessionKey,
    entry,
    event: { lifecycleGeneration: getAgentEventLifecycleGeneration(), ...event },
    clientRunId,
  });
}

describe("session lifecycle state", () => {
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(clearRuntimeConfigSnapshot);

  const goalEntry: SessionEntry = {
    sessionId: "goal-session",
    updatedAt: 1_000,
    startedAt: 1_000,
    lifecycleRunId: "goal-run",
    goal: createSessionGoalFixture("goal-1", "Finish the work", {
      createdAt: 1_000,
      updatedAt: 1_000,
      tokensUsed: 12,
    }),
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

  it("preserves an already paused goal on run failure", async () => {
    const entry = { ...goalEntry, goal: { ...goalEntry.goal!, status: "paused" as const } };
    expect((await persistLifecycle(entry, goalFailure)).goal).toEqual(entry.goal);
  });

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

  it("does not pause the goal for a stale run or pre-reset session failure (#88538)", async () => {
    for (const event of [
      { ...goalFailure, sessionId: "old-session" },
      { ...goalFailure, runId: "old-run", data: { ...goalFailure.data, startedAt: 500 } },
    ]) {
      expect((await persistLifecycle(goalEntry, event)).goal).toEqual(goalEntry.goal);
    }
  });

  it("records an explicitly captured preparation failure only on its unowned session revision", () => {
    const entry: SessionEntry = {
      sessionId: "preparation-session",
      lifecycleRevision: "preparation-revision",
      updatedAt: 900,
    };
    const input: SessionLifecyclePatchInput = {
      canonicalKey: "agent:main:preparation",
      currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
      lifecycleRevision: entry.lifecycleRevision,
      exactCronRun: false,
      expectedWriter: {
        allowUnstartedFailure: true,
        runId: "preparation-run",
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
      },
      event: lifecycleEvent(
        { phase: "error", startedAt: 1_000, endedAt: 2_000, error: "Checkout failed" },
        { sessionId: entry.sessionId, runId: "preparation-run" },
      ),
    };
    expect(projectSessionLifecyclePatch(entry, input).patch).toMatchObject({
      status: "failed",
      lastRunId: "preparation-run",
    });
    for (const replacement of [
      { ...entry, activeWriterRunId: "other-run" },
      { ...entry, lifecycleRunId: "other-run" },
      { ...entry, sessionId: "replaced-session" },
      { ...entry, lifecycleRevision: "replaced-revision" },
      { ...entry, startedAt: 1_500 },
    ]) {
      expect(projectSessionLifecyclePatch(replacement, input).patch).toBeNull();
    }
    expect(
      projectSessionLifecyclePatch(entry, {
        ...input,
        expectedWriter: {
          runId: "preparation-run",
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
        },
      }).patch,
    ).toBeNull();
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
      const first = await persistLifecycle(freshEntry, startEvent(1_000, "run-a"));
      const second = await persistLifecycle(first, startEvent(2_000, "run-b"));
      expect(second.lifecycleRunId).toBe("run-b");
      const afterOlderTerminal = await persistLifecycle(
        second,
        lifecycleEvent(
          {
            phase,
            startedAt: 1_000,
            endedAt: 3_000,
            ...(phase === "error" ? { error: "older run failed" } : {}),
          },
          { ts: 3_000, runId: "run-a" },
        ),
      );

      expect(afterOlderTerminal).toMatchObject({ startedAt: 2_000 });
      expect(afterOlderTerminal.status).toBeUndefined();
      expect(afterOlderTerminal.lifecycleRunId).toBe("run-b");
      expect(afterOlderTerminal.endedAt).toBeUndefined();
      expect(afterOlderTerminal.lastRunError).toBeUndefined();

      const completed = await persistLifecycle(
        afterOlderTerminal,
        lifecycleEvent(
          { phase: "end", startedAt: 2_000, endedAt: 4_000 },
          { ts: 4_000, runId: "run-b" },
        ),
      );
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
    const started = await persistLifecycle(freshEntry, startEvent(2_000, "run-a"));
    const completed = await persistLifecycle(
      started,
      lifecycleEvent(
        { phase: "end", startedAt: 1_900, endedAt: 3_000 },
        { ts: 3_000, runId: "run-a" },
      ),
    );

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
      { ...startEvent(1_000, "run-a"), ts: 2_100 },
    );

    expect(completed).toMatchObject({
      status: "done",
      endedAt: 2_000,
      lastRunId: "run-a",
    });
  });

  it.each([false, true])(
    "keeps provider ownership while recording the client terminal run (separate fact: %s)",
    async (separate) => {
      const started = await persistLifecycle(
        freshEntry,
        {
          ...startEvent(1_000, "provider-run"),
          ...(!separate ? { clientRunId: "client-run" } : {}),
        },
        undefined,
        separate ? "client-run" : undefined,
      );
      expect(started.lifecycleRunId).toBe("provider-run");
      expect(started.status).toBeUndefined();

      const completed = await persistLifecycle(
        started,
        lifecycleEvent(
          { phase: "end", startedAt: 1_000, endedAt: 2_000 },
          {
            runId: "provider-run",
            ...(!separate ? { clientRunId: "client-run" } : {}),
          },
        ),
        undefined,
        separate ? "client-run" : undefined,
      );

      expect(completed.lifecycleRunId).toBeUndefined();
      expect(completed.lastRunId).toBe("client-run");
    },
  );

  it("clears inherited run ownership when a start event has no run id", async () => {
    const started = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 900,
        startedAt: 900,
        lifecycleRunId: "old-run",
        lastRunId: "old-run",
      },
      startEvent(2_000),
    );

    expect(started.lifecycleRunId).toBeUndefined();
    expect(started.lastRunId).toBeUndefined();
  });

  it.each([
    terminalCase(
      "hook-handled turn without provider dispatch",
      { phase: "end", providerStarted: false },
      "done",
    ),
    terminalCase("aborted", { phase: "end", stopReason: "aborted" }, "killed", true),
    terminalCase("signal-only cancellation", { phase: "end", aborted: true }, "killed", true),
    terminalCase(
      "provider timeout",
      {
        phase: "error",
        error: "provider request timed out",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      "timeout",
    ),
    terminalCase("abandoned", { phase: "end", livenessState: "abandoned" }),
    terminalCase("error with stale yield metadata", {
      phase: "error",
      error: "continuation setup failed",
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    }),
    terminalCase("aborted with stale yield metadata", {
      phase: "end",
      aborted: true,
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    }),
  ])("persists $name terminal state", async ({ data, status, abortedLastRun }) => {
    const persisted = await persistLifecycle(runningEntry, lifecycleEvent(data));

    expect(persisted).toMatchObject({
      status,
      startedAt: 1_050,
      endedAt: 1_800,
      runtimeMs: 750,
      abortedLastRun,
    });
  });

  it.each([
    { name: "visible run", controlUiVisible: true, lastActivityAt: 1_800 },
    { name: "hidden run", controlUiVisible: false, lastActivityAt: 1_000 },
  ])(
    "records unread-worthy completion activity for a $name",
    async ({ controlUiVisible, lastActivityAt }) => {
      const persisted = await persistLifecycle(
        { ...runningEntry, lastActivityAt: 1_000 },
        lifecycleEvent({ phase: "end", endedAt: 1_800 }, { controlUiVisible }),
      );

      expect(persisted.lastActivityAt).toBe(lastActivityAt);
    },
  );

  it("retains yielded continuation custody without recording a terminal outcome", async () => {
    const yielded = await persistLifecycle(
      {
        ...runningEntry,
        lifecycleRunId: "yielded-run",
      },
      lifecycleEvent(
        {
          phase: "end",
          endedAt: 1_800,
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
        },
        { runId: "yielded-run" },
      ),
    );

    expect(yielded).toMatchObject({
      endedAt: 1_800,
      runtimeMs: 750,
      abortedLastRun: false,
      lifecycleRunId: "yielded-run",
    });
    expect(yielded.status).toBeUndefined();

    const resumed = await persistLifecycle(yielded, startEvent(2_100, "yielded-run"));
    expect(resumed.status).toBeUndefined();
    expect(resumed.endedAt).toBeUndefined();
    expect(resumed.startedAt).toBe(2_100);
  });

  it("does not infer pending continuation from end_turn without explicit yield metadata", async () => {
    const persisted = await persistLifecycle(
      runningEntry,
      lifecycleEvent({
        phase: "end",
        endedAt: 1_800,
        livenessState: "paused",
        stopReason: "end_turn",
      }),
    );

    expect(persisted.status).toBe("done");
  });

  it.each([
    cronCase("accepts the initial owner while running", cronSessionEntry("running"), {
      runId: "initial-run",
      expectedStatus: "done",
    }),
    cronCase(
      "accepts the active continuation owner",
      cronSessionEntry("continuing", "continuation-run"),
      { expectedStatus: "done" },
    ),
    cronCase("ignores events once ready", cronSessionEntry("ready")),
    cronCase(
      "ignores a stale continuation owner",
      cronSessionEntry("continuing", "current-owner"),
      { runId: "stale-owner" },
    ),
    cronCase("ignores a stale session id", cronSessionEntry("continuing", "continuation-run"), {
      sessionId: "stale-session-id",
    }),
  ])("direct persistence $name", async ({ entry, runId, sessionId, expectedStatus }) => {
    const persisted = await persistLifecycle(
      entry,
      lifecycleEvent({ phase: "end", startedAt: 1_300, endedAt: 1_950 }, { runId, sessionId }),
      exactCronSessionKey,
    );

    expect(persisted?.status).toBe(expectedStatus);
    // One exact-row write only. Continuation settlement owns base projection.
    expect(persistenceMocks.updateSessionEntry).toHaveBeenCalledTimes(1);
    expect(persistenceMocks.updateSessionEntry.mock.calls[0]?.[0]).toMatchObject({
      target: { canonicalKey: exactCronSessionKey },
    });
    expect(persistenceMocks.updateSessionEntry.mock.calls[0]?.[2]).toMatchObject({
      requireWriteSuccess: true,
    });
  });
});

it("preserves intentional field clears in a lifecycle projection", () => {
  const next = deriveGatewaySessionLifecycleProjectionPatch({
    entry: { endedAt: 1_800, runtimeMs: 900 },
    event: { ts: 2_100, runId: "new-run", data: { phase: "start", startedAt: 2_100 } },
  });
  expect(Object.hasOwn(next, "status")).toBe(true);
  expect(Object.hasOwn(next, "endedAt")).toBe(true);
  expect(Object.hasOwn(next, "runtimeMs")).toBe(true);
  expect({ status: "done", endedAt: 1_800, runtimeMs: 900, ...next }).toMatchObject({
    status: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
  });
});

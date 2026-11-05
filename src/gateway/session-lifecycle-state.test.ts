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

  const goalEntry = {
    ...runningEntry,
    lifecycleRunId: "goal-run",
    goal: createSessionGoalFixture("goal-1", "Finish the work", {
      createdAt: 1_000,
      updatedAt: 1_000,
      tokensUsed: 12,
    }),
  } satisfies SessionEntry;
  const goalFailure = lifecycleEvent(
    { phase: "error", endedAt: 2_000, error: "stream disconnected before completion" },
    { runId: "goal-run" },
  );
  const goalStop: LifecycleEvent = {
    ...goalFailure,
    data: {
      ...goalFailure.data,
      phase: "end",
      status: "cancelled",
      aborted: true,
      stopReason: "rpc",
    },
  };

  it("preserves an already paused goal on run failure", async () => {
    const entry = { ...goalEntry, goal: { ...goalEntry.goal!, status: "paused" as const } };
    expect((await persistLifecycle(entry, goalFailure)).goal).toEqual(entry.goal);
  });

  it.each([
    { phase: "start", startedAt: 1_000 },
    { phase: "end", endedAt: 2_000, stopReason: "stop" },
    { phase: "end", aborted: true, stopReason: "superseded", endedAt: 2_000 },
    { phase: "end", yielded: true, livenessState: "waiting", endedAt: 2_000 },
    { phase: "error", aborted: true, stopReason: "restart", endedAt: 2_000 },
  ])("keeps the goal active for non-failure lifecycle $phase / $stopReason", async (data) => {
    expect((await persistLifecycle(goalEntry, { ...goalFailure, data })).goal).toEqual(
      goalEntry.goal,
    );
  });

  it.each([true, false])(
    "stops an admitted pre-run Goal only for its own input (own: %s)",
    async (own) => {
      const stopped = await persistLifecycle(goalEntry, {
        ...goalStop,
        runId: own ? "goal-run" : "queued-run",
        data: { ...goalStop.data, executionStarted: false },
      });
      expect(stopped.goal?.status).toBe(own ? "paused" : "active");
      expect(stopped.goal?.lastStatusNote).toBe(
        own ? "Paused after Stop. Resume to continue." : undefined,
      );
      if (!own) {
        expect(stopped).toEqual(goalEntry);
      }
    },
  );

  it.each([goalFailure, goalStop])(
    "preserves newer Goal/session ownership (#88538) via $data.phase / $data.stopReason",
    async (event) => {
      for (const newer of [
        { ...goalEntry, sessionId: "new-session" },
        { ...goalEntry, lifecycleRunId: "new-run", startedAt: 2_500 },
        { ...goalEntry, goal: { ...goalEntry.goal!, updatedAt: 2_500 } },
        {
          ...goalEntry,
          goal: { ...goalEntry.goal!, id: "replacement-goal", createdAt: 2_500, updatedAt: 2_500 },
        },
      ]) {
        const persisted = await persistLifecycle(newer, {
          ...event,
          data: { ...event.data, startedAt: 1_000 },
        });
        expect(persisted.goal).toEqual(newer.goal);
      }
    },
  );

  it("records an explicitly captured preparation failure only on its unowned session revision", () => {
    const entry: SessionEntry = {
      ...freshEntry,
      lifecycleRevision: "preparation-revision",
      goal: goalEntry.goal,
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

  it("settles a same-run terminal before its embedded start and refuses a delayed same-run start", async () => {
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
      lastRunId: "run-a",
    });
    expect(completed.lifecycleRunId).toBeUndefined();
    expect(await persistLifecycle(completed, { ...startEvent(1_900, "run-a"), ts: 3_100 })).toEqual(
      completed,
    );
  });

  it.each([false, true])(
    "keeps provider ownership while recording the client terminal run (separate fact: %s)",
    async (separate) => {
      const persistClientRun = (entry: SessionEntry, event: LifecycleEvent) =>
        persistLifecycle(
          entry,
          { ...event, ...(!separate ? { clientRunId: "client-run" } : {}) },
          undefined,
          separate ? "client-run" : undefined,
        );
      const started = await persistClientRun(freshEntry, startEvent(1_000, "provider-run"));
      expect(started.lifecycleRunId).toBe("provider-run");
      expect(started.status).toBeUndefined();

      const completed = await persistClientRun(
        started,
        lifecycleEvent(
          { phase: "end", startedAt: 1_000, endedAt: 2_000 },
          { runId: "provider-run" },
        ),
      );

      expect(completed.lifecycleRunId).toBeUndefined();
      expect(completed.lastRunId).toBe("client-run");
    },
  );

  it("clears inherited run ownership when a start event has no run id", async () => {
    const started = await persistLifecycle(
      { ...freshEntry, startedAt: 900, lifecycleRunId: "old-run", lastRunId: "old-run" },
      startEvent(2_000),
    );

    expect(started.lifecycleRunId).toBeUndefined();
    expect(started.lastRunId).toBeUndefined();
  });

  it.each([
    terminalCase("error", goalFailure.data),
    terminalCase("error final", { ...goalFailure.data, phase: "end", stopReason: "error" }),
    terminalCase(
      "timeout final",
      { ...goalFailure.data, phase: "end", stopReason: "timeout" },
      "timeout",
    ),
    terminalCase("RPC Stop", goalStop.data, "killed", true),
    terminalCase(
      "end_turn without yield metadata",
      { phase: "end", livenessState: "paused", stopReason: "end_turn" },
      "done",
    ),
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
  ])("persists $name terminal state and Goal status", async ({ data, status, abortedLastRun }) => {
    const persisted = await persistLifecycle(
      goalEntry,
      lifecycleEvent(data, { runId: "goal-run" }),
    );

    expect(persisted).toMatchObject({
      status,
      startedAt: 1_050,
      endedAt: 1_800,
      runtimeMs: 750,
      abortedLastRun,
    });
    expect(persisted.goal).toMatchObject(
      status === "done"
        ? goalEntry.goal
        : {
            ...goalEntry.goal,
            status: "paused",
            pausedAt: 1_800,
            updatedAt: 1_800,
            lastStatusNote:
              status === "killed"
                ? "Paused after Stop. Resume to continue."
                : expect.stringContaining("Paused after an error."),
          },
    );
    if (status !== "killed" && data.error) {
      expect(persisted.goal?.lastStatusNote).toContain(data.error);
    }
    const next = await persistLifecycle(persisted, startEvent(2_100, "next-run"));
    expect(next.goal).toEqual(persisted.goal);
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

  it.each([
    [
      "thread not loaded: synthetic-thread",
      "OpenClaw couldn't find the saved conversation data needed to continue.",
    ],
    [
      "managed worktree allocation lease core:managed-worktrees:create/capacity was lost",
      "Couldn't finish preparing the code workspace.",
    ],
  ])(
    "persists startup recovery guidance rather than runtime identifiers: %s",
    async (error, title) => {
      const failed = await persistLifecycle(
        { sessionId: "session-id", updatedAt: 1000 },
        {
          ts: 2000,
          sessionId: "session-id",
          data: { phase: "error", error, endedAt: 2000 },
        },
      );
      expect(failed.status).toBe("failed");
      expect(failed.lastRunError).toContain(title);
      expect(failed.lastRunError).toContain("your request again");
      expect(failed.lastRunError?.length).toBeLessThanOrEqual(160);
      expect(failed.lastRunError).not.toContain("lease");
      expect(failed.lastRunError).not.toContain("synthetic-thread");
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

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { makeTuiState } from "./tui-event-test-support.js";
import { createTuiRunIdTracker, TuiSessionRunCoordinator } from "./tui-session-run-coordinator.js";
import type { ChatEvent, TuiHistoryLoadResult, TuiStateAccess } from "./tui-types.js";
const completedHistory = { loaded: true, runOutcome: { state: "completed" } } as const;
const activeHistory = (runId: string): TuiHistoryLoadResult => ({
  loaded: true,
  runOutcome: { state: "active", runId },
});
function createCoordinator(overrides?: {
  state?: Partial<TuiStateAccess>;
  loadHistory?: () => Promise<TuiHistoryLoadResult>;
}) {
  const state = makeTuiState({
    currentSessionId: "session-main",
    sessionInfo: {},
    ...overrides?.state,
  });
  const context = {
    state,
    loadHistory: vi.fn(overrides?.loadHistory ?? (async () => ({ ...completedHistory }))),
    restoreTerminalError: vi.fn<(message: string) => void>(),
    requestRender: vi.fn<(force?: boolean) => void>(),
    finalizeHistoryOwnedRun: vi.fn(),
    replayHistoryRunEvent: vi.fn<(event: ChatEvent) => void>(),
  };
  return { coordinator: new TuiSessionRunCoordinator(context), ...context };
}
function createControlledCoordinator() {
  let pending = createDeferred<TuiHistoryLoadResult>();
  const harness = createCoordinator({
    loadHistory: () => {
      pending = createDeferred<TuiHistoryLoadResult>();
      return pending.promise;
    },
  });
  return { ...harness, resolveHistory: (result: TuiHistoryLoadResult) => pending.resolve(result) };
}
function expectFinalized(
  finalize: ReturnType<typeof createCoordinator>["finalizeHistoryOwnedRun"],
  runId: string,
) {
  expect(finalize).toHaveBeenCalledWith({
    runId,
    result: completedHistory,
    previouslyDisplayed: false,
  });
}
it("bounds run ID tracker FIFO membership and supports explicit cleanup", () => {
  const tracker = createTuiRunIdTracker();
  tracker.note("");
  for (let index = 0; index < 200; index += 1) {
    tracker.note(`run-${index}`);
  }
  tracker.note("run-0");
  tracker.note("run-200");
  expect(tracker.has("")).toBe(false);
  expect(tracker.has("run-0")).toBe(false);
  expect(tracker.has("run-200")).toBe(true);
  tracker.forget("run-200");
  expect(tracker.has("run-200")).toBe(false);
  tracker.clear();
  expect(tracker.has("run-100")).toBe(false);
});
describe("TuiSessionRunCoordinator", () => {
  it.each([
    "finalizedRuns",
    "finalizedRunsWithDisplay",
    "persistedTerminalRunIds",
    "completedRuns",
    "postFinalizingRuns",
  ] as const)("bounds %s membership without refreshing duplicate IDs", (field) => {
    const { coordinator } = createCoordinator();
    const note = (runId: string) => {
      if (field === "persistedTerminalRunIds") {
        coordinator.notePersistedRun(runId);
      } else if (field === "postFinalizingRuns") {
        coordinator.notePostFinalizingRun(runId);
      } else if (field === "completedRuns") {
        coordinator.noteCompletedRun(runId);
      } else {
        coordinator.noteFinalizedRun(runId, { displayedFinal: true });
      }
    };
    for (let index = 0; index < 200; index += 1) {
      note(`run-${index}`);
    }
    note("run-0");
    expect(coordinator[field].size).toBe(200);
    note("run-200");
    expect(coordinator[field].size).toBe(150);
    expect(coordinator[field].has("run-0")).toBe(false);
    expect(coordinator[field].has("run-200")).toBe(true);
    coordinator.clear();
    expect(coordinator[field].size).toBe(0);
  });
  it("keeps the active session run while pruning hundreds of abandoned runs", () => {
    const { coordinator, state } = createCoordinator({
      state: { activeChatRunId: "run-live" },
    });
    coordinator.noteSessionRun("run-live");
    for (let index = 0; index < 1_000; index += 1) {
      coordinator.noteSessionRun(`run-orphan-${index}`);
    }
    expect(state.activeChatRunId).toBe("run-live");
    expect(coordinator.sessionRuns.has("run-live")).toBe(true);
    expect(coordinator.sessionRuns.size).toBeLessThanOrEqual(200);
    expect(coordinator.sessionRuns.has("run-orphan-0")).toBe(false);
  });
  it("promotes a lifecycle-confirmed run instead of newer orphan deltas", () => {
    const { coordinator } = createCoordinator();
    coordinator.noteSessionRun("run-confirmed", { protectStream: true });
    for (let index = 0; index < 500; index += 1) {
      coordinator.noteSessionRun(`run-orphan-${index}`);
    }
    expect(coordinator.resolveMostRecentPromotableRun()).toBe("run-confirmed");
    coordinator.dropSessionRun("run-confirmed");
    expect(coordinator.resolveMostRecentPromotableRun()).toBeUndefined();
    expect(coordinator.isRetiredOrphanRun("run-orphan-499")).toBe(true);
    coordinator.noteSessionRun("run-orphan-499");
    expect(coordinator.sessionRuns.has("run-orphan-499")).toBe(false);
    coordinator.noteSessionRun("run-orphan-0");
    coordinator.noteSessionRun("run-never-seen");
    expect(coordinator.sessionRuns.has("run-orphan-0")).toBe(false);
    expect(coordinator.sessionRuns.has("run-never-seen")).toBe(false);
    coordinator.noteSessionRun("run-orphan-499", { protectStream: true });
    expect(coordinator.sessionRuns.has("run-orphan-499")).toBe(true);
    expect(coordinator.isRetiredOrphanRun("run-orphan-499")).toBe(false);
    coordinator.noteSessionRun("run-orphan-after-reactivation");
    expect(coordinator.sessionRuns.has("run-orphan-after-reactivation")).toBe(false);
    coordinator.clear();
    coordinator.noteSessionRun("run-after-session-reset");
    expect(coordinator.sessionRuns.has("run-after-session-reset")).toBe(true);
  });
  it("keeps an accepted submit eligible for activity promotion", () => {
    const { coordinator } = createCoordinator({
      state: {
        pendingSubmit: { phase: "accepted", runId: "run-pending", draftText: null },
      },
    });
    coordinator.noteSessionRun("run-pending");
    coordinator.noteSessionRun("run-orphan");
    expect(coordinator.resolveMostRecentPromotableRun()).toBe("run-pending");
  });
  it.each(["sending", "accepted"] as const)(
    "retires only unchanged history observations and preserves a %s submit",
    (phase) => {
      vi.useFakeTimers();
      try {
        const { coordinator } = createCoordinator({
          state: {
            activeChatRunId: "run-visible",
            pendingSubmit: { phase, runId: "run-pending", draftText: "pending" },
          },
        });
        for (const runId of ["run-old", "run-reobserved", "run-visible", "run-pending"]) {
          coordinator.noteSessionRun(runId, { protectStream: true });
        }
        const reconcile = coordinator.captureHistoryRunMembership();
        // The clock intentionally does not advance: timestamps are not revisions.
        coordinator.noteSessionRun("run-reobserved", { protectStream: true });
        coordinator.noteSessionRun("run-new");
        reconcile([]);
        expect([...coordinator.sessionRuns.keys()]).toEqual([
          "run-reobserved",
          "run-visible",
          "run-pending",
          "run-new",
        ]);
        expect(coordinator.finalizedRuns.has("run-old")).toBe(false);
        expect(coordinator.persistedTerminalRunIds.has("run-old")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("does not let an old session history retire a reset session's run", () => {
    const { coordinator } = createCoordinator();
    coordinator.noteSessionRun("run-reused", { protectStream: true });
    const reconcile = coordinator.captureHistoryRunMembership();
    coordinator.clear();
    coordinator.noteSessionRun("run-reused", { protectStream: true });
    reconcile([]);
    expect(coordinator.resolveMostRecentPromotableRun()).toBe("run-reused");
  });
  it("serializes queued reloads and replays a gated terminal event", async () => {
    const {
      coordinator,
      loadHistory,
      finalizeHistoryOwnedRun,
      replayHistoryRunEvent,
      resolveHistory,
    } = createControlledCoordinator();
    const deferredEvent: ChatEvent = {
      runId: "run-first",
      sessionKey: "agent:main:main",
      state: "final",
      message: { content: [{ type: "text", text: "persisted reply" }] },
    };
    void coordinator.queueHistoryReload(["run-first"], ["run-first"]);
    coordinator.deferHistoryRunEvent(deferredEvent);
    void coordinator.queueHistoryReload();
    expect(loadHistory).toHaveBeenCalledTimes(1);
    resolveHistory(completedHistory);
    await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    expectFinalized(finalizeHistoryOwnedRun, "run-first");
    expect(replayHistoryRunEvent).toHaveBeenCalledWith(deferredEvent);
    resolveHistory(completedHistory);
  });
  it.each([false, true])("awaits the complete history drain across a reset: %s", async (reset) => {
    const first = createDeferred<TuiHistoryLoadResult>();
    const second = createDeferred<TuiHistoryLoadResult>();
    const reads = vi
      .fn<() => Promise<TuiHistoryLoadResult>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { coordinator, loadHistory } = createCoordinator({ loadHistory: reads });
    const settled = vi.fn();
    const firstDrain = coordinator.queueHistoryReload();
    void firstDrain.then(settled);
    if (reset) {
      coordinator.clear();
    }
    const secondDrain = coordinator.queueHistoryReload();
    void secondDrain.then(settled);
    expect(loadHistory).toHaveBeenCalledTimes(1);
    first.resolve(completedHistory);
    await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    expect(settled).not.toHaveBeenCalled();
    second.resolve(completedHistory);
    await expect(Promise.all([firstDrain, secondDrain])).resolves.toEqual([!reset, true]);
    expect(settled).toHaveBeenCalledTimes(2);
  });
  it("does not finalize a gap-recovery run when authoritative history fails", async () => {
    const { coordinator, loadHistory, finalizeHistoryOwnedRun } = createCoordinator({
      loadHistory: async () => {
        throw new Error("history temporarily unavailable");
      },
    });
    coordinator.queueGapHistoryReload(["run-gap"]);
    await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(coordinator.isHistoryReloadingRun("run-gap")).toBe(false));
    expect(finalizeHistoryOwnedRun).not.toHaveBeenCalled();
  });
  it("reconciles every tracked run after a Gateway event gap", async () => {
    const { coordinator, finalizeHistoryOwnedRun } = createCoordinator();
    coordinator.queueGapHistoryReload(["run-first", "run-second"]);
    await vi.waitFor(() => expect(finalizeHistoryOwnedRun).toHaveBeenCalledTimes(2));
    expectFinalized(finalizeHistoryOwnedRun, "run-first");
    expectFinalized(finalizeHistoryOwnedRun, "run-second");
  });
  it.each([
    { membership: "exact", activeRunIds: ["run-first", "run-second"] },
    { membership: "unknown", activeRunIds: undefined },
  ])("keeps concurrent runs after a gap with $membership membership", async ({ activeRunIds }) => {
    const { coordinator, finalizeHistoryOwnedRun } = createCoordinator({
      loadHistory: async () => ({
        ...activeHistory("run-second"),
        ...(activeRunIds ? { activeRunIds } : {}),
      }),
    });
    coordinator.queueGapHistoryReload(["run-first", "run-second"]);
    await vi.waitFor(() => expect(coordinator.isHistoryReloadingRun("run-first")).toBe(false));
    expect(finalizeHistoryOwnedRun).not.toHaveBeenCalled();
  });
  it.each([
    { tracked: true, observation: "delta" },
    { tracked: false, observation: "delta" },
    { tracked: true, observation: "lifecycle" },
    { tracked: false, observation: "lifecycle" },
  ])(
    "preserves newer $observation without finalizing older history (tracked=$tracked)",
    async ({ tracked, observation }) => {
      const { coordinator, finalizeHistoryOwnedRun, replayHistoryRunEvent, resolveHistory } =
        createControlledCoordinator();
      if (tracked) {
        coordinator.noteSessionRun("run-live", { protectStream: true });
      }
      const reconcile = coordinator.captureHistoryRunMembership();
      coordinator.queueGapHistoryReload(["run-live"]);
      const delta: ChatEvent = {
        runId: "run-live",
        sessionKey: "agent:main:main",
        seq: 2,
        state: "delta",
        message: { role: "assistant", content: "still running" },
      };
      if (observation === "delta") {
        coordinator.deferHistoryRunEvent(delta);
      } else {
        coordinator.noteSessionRun("run-live", { protectStream: true });
      }
      reconcile([]);
      if (tracked) {
        expect(coordinator.sessionRuns.has("run-live")).toBe(true);
      }
      resolveHistory(completedHistory);
      await vi.waitFor(() => expect(coordinator.isHistoryReloadingRun("run-live")).toBe(false));
      if (observation === "delta") {
        expect(replayHistoryRunEvent).toHaveBeenCalledWith(delta);
      }
      expect(finalizeHistoryOwnedRun).not.toHaveBeenCalled();
    },
  );
  it("allows a later queued history to supersede a delta from the previous reload", async () => {
    const { coordinator, loadHistory, finalizeHistoryOwnedRun, resolveHistory } =
      createControlledCoordinator();
    coordinator.queueGapHistoryReload(["run-live"]);
    coordinator.queueGapHistoryReload(["run-live"]);
    coordinator.deferHistoryRunEvent({
      runId: "run-live",
      sessionKey: "agent:main:main",
      seq: 2,
      state: "delta",
      message: { role: "assistant", content: "before the next snapshot" },
    });
    resolveHistory(completedHistory);
    await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    expect(finalizeHistoryOwnedRun).not.toHaveBeenCalled();
    resolveHistory(completedHistory);
    await vi.waitFor(() => expect(finalizeHistoryOwnedRun).toHaveBeenCalledTimes(1));
  });
  it.each([
    { firstHistory: "still streaming", inFlightRunId: "run-gap" },
    { firstHistory: "already completed", inFlightRunId: null },
  ])(
    "defers overlapping gap finalization when the older history is $firstHistory",
    async ({ inFlightRunId }) => {
      const { coordinator, loadHistory, finalizeHistoryOwnedRun, resolveHistory } =
        createControlledCoordinator();
      coordinator.queueGapHistoryReload(["run-gap"]);
      coordinator.queueGapHistoryReload(["run-gap"]);
      expect(loadHistory).toHaveBeenCalledTimes(1);
      resolveHistory(inFlightRunId ? activeHistory(inFlightRunId) : completedHistory);
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
      expect(finalizeHistoryOwnedRun).not.toHaveBeenCalled();
      resolveHistory(completedHistory);
      await vi.waitFor(() => expect(finalizeHistoryOwnedRun).toHaveBeenCalledTimes(1));
      expectFinalized(finalizeHistoryOwnedRun, "run-gap");
    },
  );
  it("discards a stale in-flight reload when the selected session resets", async () => {
    const { coordinator, finalizeHistoryOwnedRun, replayHistoryRunEvent, resolveHistory } =
      createControlledCoordinator();
    void coordinator.queueHistoryReload(["run-stale"], ["run-stale"]);
    coordinator.clear();
    resolveHistory(completedHistory);
    await vi.waitFor(() => {
      expect(finalizeHistoryOwnedRun).not.toHaveBeenCalled();
      expect(replayHistoryRunEvent).not.toHaveBeenCalled();
    });
    expect(coordinator.isHistoryReloadingRun("run-stale")).toBe(false);
  });
});

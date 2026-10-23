import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../config/sessions/activity-summary.js";
import type { SessionActivitySummary } from "../config/sessions/activity-summary.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  readSessionTranscriptWatermark,
  SessionTranscriptProjectionUnavailableError,
} from "../config/sessions/session-accessor.js";
import { seedUnindexedTranscriptForTest } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { isSessionTranscriptIndexReconcileRunning } from "../config/sessions/session-transcript-reconcile.js";
import * as transcriptWatermark from "../config/sessions/session-transcript-watermark.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import {
  createSessionActivitySummaries,
  type SessionActivitySummaryService,
} from "./session-activity-summaries.js";
import {
  preparedActivityRecapModel,
  recapRpc,
  seedRecapConversation,
} from "./session-activity-summaries.test-support.js";
import { readActivitySummaryBatch } from "./session-activity-summary-source.worker.js";
import {
  projectSessionActivitySummary,
  type ActivitySummaryTarget,
} from "./session-activity-summary-state.js";
import type { defaultCompleteModel, defaultPrepareModel } from "./session-observer-model.js";
import * as observerModel from "./session-observer-model.js";

const result = {
  text: "Verified the change.",
  provider: "test",
  model: "utility",
  owner: { kind: "harness" as const, id: "test" },
};
const scope = (target: ActivitySummaryTarget) => ({
  agentId: target.agentId,
  sessionKey: target.key,
  sessionId: target.key,
});

describe("Activity recap admission, refresh, and provider recovery", () => {
  let testState: OpenClawTestState;
  let service: SessionActivitySummaryService;
  let scheduler: GatewayScheduler;
  let cfg: OpenClawConfig;
  const complete = vi.fn<typeof defaultCompleteModel>();
  const prepareModel: typeof defaultPrepareModel = async ({ agentId, modelRef }) => ({
    ...preparedActivityRecapModel,
    config: cfg,
    agentId,
    model: modelRef?.split("/")[1] ?? "utility",
  });
  const prepare = vi.fn<typeof defaultPrepareModel>();
  const changed = vi.fn();
  const view = (target: ActivitySummaryTarget) =>
    projectSessionActivitySummary({
      ...target,
      cfg,
      entry: loadSessionEntryReadOnly(scope(target)),
      watermark: readSessionTranscriptWatermark(scope(target)),
    });
  const publication = (
    target: ActivitySummaryTarget,
    ready = (summary: ReturnType<typeof view>) => summary?.state === "current",
  ) => {
    const settled = createDeferred<ReturnType<typeof view>>();
    changed.mockImplementation(() => {
      const summary = view(target);
      if (ready(summary)) {
        settled.resolve(summary);
      }
    });
    return settled.promise;
  };
  const patchSummary = (target: ActivitySummaryTarget, patch: Partial<SessionActivitySummary>) =>
    patchSessionEntryCore(
      scope(target),
      (entry) => ({
        activitySummary: { ...entry.activitySummary!, ...patch },
      }),
      { preserveActivity: true },
    );
  const addSession = async (index: number, agentId = "main") => {
    const target = { agentId, key: `agent:${agentId}:recap-${index}` };
    await seedRecapConversation(scope(target), `Request ${index}`, {}, `message-${index}`);
    return target;
  };
  const appendMessage = (
    target: ActivitySummaryTarget,
    eventId: string,
    parentId: string,
    content: string,
  ) =>
    persistSessionTranscriptTurn(scope(target), {
      messages: [{ eventId, parentId, message: { role: "assistant", content } }],
      touchSessionEntry: false,
    });
  const appendWork = (target: ActivitySummaryTarget) =>
    appendMessage(target, "new-work", "message-1", "Verified additional work.");
  const fakeTime = () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
  };

  const createService = () =>
    createSessionActivitySummaries({
      scheduler,
      getConfig: () => cfg,
      onChanged: changed,
    });

  const restartWithClock = async (onArmed: () => void) => {
    await service.dispose();
    await scheduler.stop();
    const time = createGatewaySchedulerClock(Date.now());
    scheduler = createTestGatewayScheduler({
      ...time.clock,
      arm(run, delayMs) {
        const cancel = time.clock.arm(run, delayMs);
        onArmed();
        return cancel;
      },
    });
    service = createService();
    return time;
  };

  const ensureRecap = async (target: Parameters<SessionActivitySummaryService["ensure"]>[0]) =>
    service.ensure(
      target,
      await readSessionEntryReadOnlyInWorker({
        agentId: target.agentId,
        sessionKey: target.key,
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId }),
      }),
    );

  beforeEach(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal" });
    cfg = { agents: { defaults: { utilityModel: "test/utility" } } };
    setRuntimeConfigSnapshot(cfg);
    complete.mockReset().mockResolvedValue(result);
    prepare.mockReset().mockImplementation(prepareModel);
    vi.spyOn(observerModel, "defaultPrepareModel").mockImplementation(prepare);
    vi.spyOn(observerModel, "defaultCompleteModel").mockImplementation(complete);
    changed.mockReset();
    scheduler = createTestGatewayScheduler("fake-timers");
    service = createService();
  });
  afterEach(async () => {
    await service.dispose();
    await scheduler.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await testState.cleanup();
  });

  it("refreshes a recap dirtied by an in-process append without a post-write watermark read", async ({
    signal,
  }) => {
    const target = await addSession(1);
    const transcript = scope(target);
    const read = () => loadSessionEntryReadOnly(transcript);
    const readWatermark = vi.spyOn(transcriptWatermark, "readSessionTranscriptWatermarkAsync");
    complete.mockImplementationOnce(async () => {
      await appendWork(target);
      service.handleTranscript({ target: transcript });
      return { ...result, text: "Only the first message was summarized." };
    });
    const firstPublication = createDeferred();
    changed.mockImplementation(() => {
      if (read()?.activitySummary) {
        firstPublication.resolve();
      }
    });
    await ensureRecap(target);
    await withinTest(firstPublication.promise, signal);
    expect(view(target)?.state).toBe("updating");
    expect(read()?.activitySummary).toMatchObject({ coveredMessages: 1, totalMessages: 1 });
    expect(readWatermark).not.toHaveBeenCalled();

    const current = publication(target);
    await ensureRecap(target);
    await withinTest(current, signal);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(read()?.activitySummary).toMatchObject({ coveredMessages: 2, totalMessages: 2 });
  });

  it("refreshes the bounded recap source after a committed append", async () => {
    const target = await addSession(1);
    const transcript = scope(target);
    const initial = readActivitySummaryBatch({ scope: transcript })!;
    expect(initial.snapshot.totalMessages).toBe(1);
    expect(initial.page.events).toMatchObject([
      { event: { message: { role: "user", content: "Request 1" } } },
    ]);
    const previous = {
      version: 1 as const,
      formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
      text: result.text,
      updatedAt: 1,
      sessionId: transcript.sessionId,
      ...initial.watermark,
      leafEntryId: initial.snapshot.activeLeafEntryId ?? null,
      coveredMessages: 1,
      totalMessages: 1,
      omittedContent: false,
    };

    await appendWork(target);

    const appended = readActivitySummaryBatch({ scope: transcript, previous })!;
    expect(appended.covered).toBe(1);
    expect(appended.snapshot.totalMessages).toBe(2);
    expect(appended.page.scannedMessages).toBe(1);
    expect(appended.page.events).toMatchObject([
      { event: { message: { role: "assistant", content: "Verified additional work." } } },
    ]);
    expect(appended.watermark.generation).toBe(initial.watermark.generation);
    expect(appended.watermark.maxSeq).toBeGreaterThan(initial.watermark.maxSeq!);
    expect(appended.omitted).toBe(false);
  });

  it("rebuilds a dirty imported projection before retrying the recap", async () => {
    const target = { agentId: "main", key: "agent:main:unindexed-recap" };
    const transcript = scope(target);
    const databaseOptions = { agentId: target.agentId, env: testState.env };
    await seedUnindexedTranscriptForTest({
      ...transcript,
      entry: { sessionId: transcript.sessionId, updatedAt: 1 },
      events: [
        { type: "session", id: transcript.sessionId, version: 3 },
        {
          type: "message",
          id: "request",
          parentId: null,
          message: { role: "user", content: "Repair the import." },
        },
        {
          type: "message",
          id: "answer",
          parentId: "request",
          message: { role: "assistant", content: "Repaired the import." },
        },
      ].map((event, seq) => ({
        session_id: transcript.sessionId,
        seq,
        created_at: seq + 1,
        event_json: JSON.stringify(event),
      })),
    });
    openOpenClawAgentDatabase(databaseOptions)
      .db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      )
      .run(transcript.sessionId);
    expect(() => readActivitySummaryBatch({ scope: transcript })).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    expect(isSessionTranscriptIndexReconcileRunning(databaseOptions)).toBe(false);

    const settled = publication(
      target,
      (summary) => summary?.state === "current" || summary?.state === "unavailable",
    );
    await ensureRecap(target);
    expect(await settled).toMatchObject({ state: "current", text: result.text });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.parse(complete.mock.calls[0]![0].prompt).messages).toEqual([
      "user: Repair the import.",
      "assistant: Repaired the import.",
    ]);
    expect(loadSessionEntryReadOnly(transcript)?.activitySummary?.coveredMessages).toBe(2);
  });

  it("does not call the model after a grouped child becomes hidden during preparation", async () => {
    const target = await addSession(1);
    await patchSessionEntryCore(scope(target), () => ({
      spawnedBy: "agent:main:main",
      category: "Work",
    }));
    const started = createDeferred();
    const preparation = createDeferred();
    prepare.mockImplementationOnce(async (params) => {
      started.resolve();
      await preparation.promise;
      return prepareModel(params);
    });
    const settled = publication(target, (summary) => summary?.state !== "updating");
    await ensureRecap(target);
    try {
      await started.promise;
      await patchSessionEntryCore(scope(target), () => ({ category: undefined }), {
        preserveActivity: true,
      });
      preparation.resolve();
      expect(await settled).toMatchObject({ state: "stale" });
      expect(complete).not.toHaveBeenCalled();
      expect(loadSessionEntryReadOnly(scope(target))?.activitySummary).toBeUndefined();
    } finally {
      preparation.resolve();
    }
  });

  it.each(["toolResult", "user", "assistant"])(
    "counts only oversized recap messages through legacy migration (%s)",
    async (role) => {
      const notice = " (Some oversized messages were omitted.)";
      const recap = result.text;
      const target = await addSession(0);
      await persistSessionTranscriptTurn(scope(target), {
        messages: [
          {
            eventId: "message-1",
            parentId: "message-0",
            message: {
              role,
              content:
                role === "toolResult"
                  ? [{ type: "image", mimeType: "image/png", data: "A".repeat(200_000) }]
                  : "Oversized conversation text. ".repeat(10_000),
            },
          },
          {
            eventId: "message-2",
            parentId: "message-1",
            message: { role: "assistant", content: "Verified the requested work." },
          },
        ],
        touchSessionEntry: false,
      });
      const refresh = async () => {
        const settled = createDeferred();
        let requested = false;
        changed.mockImplementation(() => {
          if (requested && view(target)?.state === "current") {
            settled.resolve();
          }
        });
        await ensureRecap(target);
        requested = true;
        await settled.promise;
      };
      await refresh();
      const summaryText = recap + (role === "toolResult" ? "" : notice);
      expect(loadSessionEntryReadOnly(scope(target))?.activitySummary).toMatchObject({
        text: summaryText,
        omittedContent: role !== "toolResult",
        coveredMessages: 3,
      });
      await patchSummary(target, { formatRevision: 2, omittedContent: true, text: recap + notice });
      await service.dispose();
      service = createService();
      expect(view(target)).toMatchObject({ state: "stale", text: recap + notice });
      complete.mockClear();
      await refresh();
      expect(complete).not.toHaveBeenCalled();
      expect(loadSessionEntryReadOnly(scope(target))?.activitySummary).toMatchObject({
        formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
        text: summaryText,
        omittedContent: role !== "toolResult",
      });
      if (role === "user") {
        const summary = loadSessionEntryReadOnly(scope(target))!.activitySummary!;
        const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
        const countReads = (formatRevision: number) => {
          reads.queries.length = 0;
          readActivitySummaryBatch({
            scope: scope(target),
            previous: { ...summary, formatRevision },
          });
          return reads.queries.length;
        };
        try {
          countReads(2);
          countReads(ACTIVITY_SUMMARY_FORMAT_REVISION);
          expect(countReads(ACTIVITY_SUMMARY_FORMAT_REVISION)).toBeLessThan(countReads(2));
        } finally {
          reads.restore();
        }
      }
      await appendMessage(target, "message-3", "message-2", "Outcome 3");
      await refresh();
      expect(JSON.parse(complete.mock.calls[0]![0].prompt)).toMatchObject({
        previousRecap: recap,
        messages: ["assistant: Outcome 3"],
        omittedContent: role !== "toolResult",
      });
      expect(loadSessionEntryReadOnly(scope(target))?.activitySummary).toMatchObject({
        text: summaryText,
        omittedContent: role !== "toolResult",
        coveredMessages: 4,
      });
    },
  );

  it.each([false, true])(
    "restyles old cached text once while retaining coverage (new work: %s)",
    async (newWork) => {
      const target = await addSession(1);
      await ensureRecap(target);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      const oldText = "Ran internal_tool and checked the result. Waiting for review.";
      await patchSummary(target, { formatRevision: undefined, text: oldText });
      if (newWork) {
        await appendWork(target);
      }
      expect(view(target)).toMatchObject({ state: "stale", text: oldText });
      const restyled = createDeferred<typeof result>();
      complete.mockImplementationOnce(() => restyled.promise);
      try {
        expect(await ensureRecap(target)).toMatchObject({
          state: "updating",
          text: oldText,
        });
        await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
        expect(JSON.parse(complete.mock.calls[1]![0].prompt)).toMatchObject({
          previousRecap: oldText,
          messages: newWork ? ["assistant: Verified additional work."] : [],
        });
        restyled.resolve({ ...result, text: "Verified the change. Waiting for review." });
        await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
        expect(loadSessionEntryReadOnly(scope(target))?.activitySummary).toMatchObject({
          version: 1,
          formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
          text: "Verified the change. Waiting for review.",
          coveredMessages: newWork ? 2 : 1,
          totalMessages: newWork ? 2 : 1,
        });
      } finally {
        restyled.resolve({ ...result, text: "Verified the change. Waiting for review." });
      }
      await service.dispose();
      service = createService();
      await ensureRecap(target);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      await ensureRecap(target);
      await service.dispose();
      expect(complete).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["complete", "shutdown", "continuation"] as const)(
    "coalesces a late refresh wake and joins its model work on %s",
    async (outcome) => {
      await service.dispose();
      await scheduler.stop();
      const time = createGatewaySchedulerClock(Date.now());
      scheduler = createTestGatewayScheduler(time.clock);
      service = createService();
      const target = await addSession(1);
      const initial = publication(target);
      await ensureRecap(target);
      await initial;
      await appendWork(target);
      fakeTime();
      const started = createDeferred();
      const completion = createDeferred<typeof result>();
      const continuation = createDeferred<typeof result>();
      complete.mockImplementationOnce(() => {
        started.resolve();
        return completion.promise;
      });
      service.handleTranscript({ target: scope(target) });
      expect(time.armedAtMs).toBe(time.clock.now() + 90_000);
      time.setTime(time.clock.now() + 3_600_000);
      const wake = time.wake();
      try {
        await started.promise;
        expect(complete).toHaveBeenCalledTimes(2);
        if (outcome === "shutdown") {
          scheduler.beginClose();
          const stopped = vi.fn();
          const disposed = vi.fn();
          const stop = scheduler.stop().then(stopped);
          const disposal = service.dispose().then(disposed);
          await Promise.resolve();
          await Promise.resolve();
          expect(stopped).not.toHaveBeenCalled();
          expect(disposed).not.toHaveBeenCalled();
          expect(complete.mock.calls[1]![0].abortSignal?.aborted).toBe(true);
          completion.resolve(result);
          await Promise.all([stop, disposal]);
        } else if (outcome === "continuation") {
          await appendMessage(target, "continued-work", "new-work", "Verified the follow-on work.");
          const continued = createDeferred();
          complete.mockImplementationOnce(() => {
            continued.resolve();
            return continuation.promise;
          });
          await ensureRecap(target);
          completion.resolve(result);
          await continued.promise;
          const stopped = vi.fn();
          const stop = scheduler.stop().then(stopped);
          await vi.advanceTimersByTimeAsync(0);
          expect(stopped).not.toHaveBeenCalled();
          continuation.resolve(result);
          await stop;
        } else {
          completion.resolve(result);
        }
        await wake;
        await time.advanceBy(3_600_000);
        expect(complete).toHaveBeenCalledTimes(outcome === "continuation" ? 3 : 2);
        expect(loadSessionEntryReadOnly(scope(target))?.activitySummary?.coveredMessages).toBe(
          outcome === "shutdown" ? 1 : outcome === "continuation" ? 3 : 2,
        );
        expect(time.armedAtMs).toBeNull();
      } finally {
        completion.resolve(result);
        continuation.resolve(result);
        await wake;
      }
    },
  );

  it("retains the previous recap on restyle failure without rebilling repeated requests", async () => {
    const target = await addSession(1);
    await ensureRecap(target);
    await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
    await patchSummary(target, { formatRevision: undefined });
    complete.mockRejectedValue(new Error("temporary failure"));
    await ensureRecap(target);
    await vi.waitFor(() => expect(view(target)?.state).toBe("unavailable"));
    for (let index = 0; index < 20; index += 1) {
      await ensureRecap(target);
    }
    expect(view(target)?.text).toBe(result.text);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.for(["success", "error"] as const)(
    "retains recap slots and shutdown ownership after logical %s until physical settlement",
    async (outcome, { signal }) => {
      const targets = await Promise.all([addSession(1), addSession(2), addSession(3)]);
      const logical = createDeferred();
      const occupied = createDeferred();
      const reused = createDeferred();
      const initialOutcomes = createDeferred();
      const thirdOutcome = createDeferred();
      const settled = new Set<string>();
      const finish: Array<() => void> = [];
      const released = vi.fn();
      let active = 0;
      let maximumActive = 0;
      let disposed = false;
      let disposal: Promise<void> | undefined;
      changed.mockImplementation((target: ActivitySummaryTarget) => {
        if (view(target)?.state !== (outcome === "success" ? "current" : "unavailable")) {
          return;
        }
        settled.add(target.key);
        if (settled.size === 2) {
          initialOutcomes.resolve();
        }
        if (target.key === targets[2]!.key) {
          thirdOutcome.resolve();
        }
      });
      complete.mockImplementation(() =>
        runWithAsyncWorkResources(async (onAcquired) => {
          onAcquired({ release: released });
          const physical = createDeferred();
          finish.push(physical.resolve);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          void trackAsyncWork(() =>
            physical.promise.finally(() => {
              active -= 1;
            }),
          );
          if (finish.length === 2) {
            occupied.resolve();
          } else if (finish.length === 3) {
            reused.resolve();
          }
          await logical.promise;
          if (outcome === "error") {
            throw new Error("Logical recap ended before tracked cleanup");
          }
          return result;
        }),
      );
      try {
        for (const target of targets) {
          await ensureRecap(target);
        }
        await withinTest(occupied.promise, signal);
        expect(complete).toHaveBeenCalledTimes(2);
        logical.resolve();
        await withinTest(initialOutcomes.promise, signal);
        await nextTurn();
        expect(complete).toHaveBeenCalledTimes(2);
        expect(active).toBe(2);
        expect(released).not.toHaveBeenCalled();

        finish[0]!();
        await withinTest(reused.promise, signal);
        expect(complete).toHaveBeenCalledTimes(3);
        expect(active).toBe(2);
        expect(maximumActive).toBe(2);
        expect(released).toHaveBeenCalledOnce();
        await withinTest(thirdOutcome.promise, signal);
        disposal = service.dispose().then(() => {
          disposed = true;
        });
        await nextTurn();
        expect(disposed).toBe(false);
      } finally {
        disposal ??= service.dispose();
        logical.resolve();
        for (const release of finish) {
          release();
        }
        await withinTest(disposal, signal);
        expect(active).toBe(0);
        expect(released).toHaveBeenCalledTimes(finish.length);
      }
    },
  );

  it("queues a full Activity page and reports admission limits until a slot settles", async ({
    signal,
  }) => {
    const targets: ActivitySummaryTarget[] = [];
    for (let index = 0; index < 257; index += 1) {
      targets.push(await addSession(index));
    }
    const overflow = targets[256]!;
    const initial = publication(overflow);
    await ensureRecap(overflow);
    await withinTest(initial, signal);
    expect(view(overflow)?.state).toBe("current");
    await service.dispose();
    service = createService();
    complete.mockClear();
    const first = createDeferred<typeof result>();
    const remaining = createDeferred<typeof result>();
    const slotsOccupied = createDeferred();
    const slotReused = createDeferred();
    const drained = createDeferred();
    const completed = new Set<string>();
    changed.mockImplementation((target: ActivitySummaryTarget) => {
      if (view(target)?.state === "current") {
        completed.add(target.key);
        if (completed.size === targets.length) {
          drained.resolve();
        }
      }
    });
    complete
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => {
        slotsOccupied.resolve();
        return remaining.promise;
      })
      .mockImplementation(() => {
        slotReused.resolve();
        return remaining.promise;
      });
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      sessionActivitySummaries: service,
    });
    const { respond, invoke } = recapRpc("sessions.activitySummary.ensure", context, "capacity");
    const ensure = async (sessions: ActivitySummaryTarget[]) => {
      await invoke({ sessions });
      expect(respond.mock.calls.at(-1)?.[0]).toBe(true);
    };
    const ensureOverflow = async (state: "current" | "updating" | "unavailable") => {
      await ensure([overflow]);
      expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
        sessions: [{ ...overflow, activitySummary: { state, text: result.text, canEnsure: true } }],
      });
    };
    try {
      for (let index = 0; index < 100; index += 20) {
        await ensure(targets.slice(index, index + 20));
      }
      await withinTest(slotsOccupied.promise, signal);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(targets.slice(0, 100).map((target) => view(target)?.state)).toEqual(
        Array.from({ length: 100 }, () => "updating"),
      );
      for (let index = 100; index < 256; index += 20) {
        await ensure(targets.slice(index, Math.min(index + 20, 256)));
      }
      expect(targets.slice(0, 256).every((target) => view(target)?.state === "updating")).toBe(
        true,
      );
      await ensureOverflow("current");
      expect(view(overflow)?.state).toBe("current");
      await appendMessage(
        overflow,
        "overflow-new-work",
        "message-256",
        "Verified additional work.",
      );
      await ensureOverflow("unavailable");
      expect(complete).toHaveBeenCalledTimes(2);
      first.resolve(result);
      await withinTest(slotReused.promise, signal);
      expect(complete).toHaveBeenCalledTimes(3);
      await ensureOverflow("updating");
      remaining.resolve(result);
      await withinTest(drained.promise, signal);
      expect(targets.every((target) => view(target)?.state === "current")).toBe(true);
      expect(complete).toHaveBeenCalledTimes(257);
    } finally {
      const disposal = service.dispose();
      first.resolve(result);
      remaining.resolve(result);
      await disposal;
    }
  });

  it.for([
    {
      name: "overload",
      error: Object.assign(new Error("Overloaded"), { status: 529 }),
      delay: 30_000,
    },
    {
      name: "rate-limit response headers",
      error: Object.assign(new Error("Too many requests"), {
        status: 429,
        headers: new Headers({ "Retry-After": "90" }),
      }),
      delay: 90_000,
    },
    {
      name: "provider retry timing",
      error: Object.assign(new Error("Too many requests"), { status: 429, retryAfterMs: 90_000 }),
      delay: 90_000,
    },
    {
      name: "network interruption",
      error: new Error("fetch failed", {
        cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      }),
      delay: 30_000,
    },
  ])(
    "retries $name automatically and retains cached text without rebilling repeated ensure requests",
    async ({ error, delay }, { signal }) => {
      const retryArmed = createDeferred();
      const time = await restartWithClock(() => retryArmed.resolve());
      const target = await addSession(1);
      const initialWork = new AsyncWorkScope();
      await initialWork.track(() => ensureRecap(target));
      await initialWork.drain();
      expect(view(target)?.state).toBe("current");
      await appendWork(target);
      fakeTime();
      complete.mockRejectedValueOnce(error);
      await ensureRecap(target);
      await withinTest(retryArmed.promise, signal);
      expect(complete).toHaveBeenCalledTimes(2);
      const failedAt = time.clock.now();
      for (let index = 0; index < 20; index += 1) {
        await ensureRecap(target);
      }
      expect(view(target)).toMatchObject({ state: "updating", text: result.text });
      await time.advanceBy(delay - 1_000);
      expect(complete).toHaveBeenCalledTimes(2);
      await time.advanceBy(1_000);
      expect(view(target)?.state).toBe("current");
      expect(time.clock.now() - failedAt).toBeGreaterThanOrEqual(delay);
      expect(complete).toHaveBeenCalledTimes(3);
    },
  );

  it("pauses the overloaded model while serving another model, then retries at the queue tail", async ({
    signal,
  }) => {
    const first = await addSession(1);
    const next = await addSession(2);
    const blocker = await addSession(3, "healthy");
    const healthy = await addSession(4, "healthy");
    cfg.agents!.entries = { main: {}, healthy: { utilityModel: "test/other" } };
    const failure = createDeferred<typeof result>();
    const release = createDeferred<typeof result>();
    const started = createDeferred();
    // Initial parallel reads can reach the model callbacks in either order.
    const initialCalls = new Map([
      ["utility", failure],
      ["other", release],
    ]);
    const healthyReady = createDeferred();
    const retried = createDeferred();
    const completed = new Set<string>();
    changed.mockImplementation((target: ActivitySummaryTarget) => {
      if (view(target)?.state !== "current") {
        return;
      }
      completed.add(target.key);
      if (target.key === healthy.key) {
        healthyReady.resolve();
      }
      if (completed.has(first.key) && completed.has(next.key)) {
        retried.resolve();
      }
    });
    complete.mockImplementation(({ model }) => {
      const initial = initialCalls.get(model);
      if (!initial) {
        return Promise.resolve(result);
      }
      initialCalls.delete(model);
      if (initialCalls.size === 0) {
        started.resolve();
      }
      return initial.promise;
    });
    fakeTime();
    try {
      await ensureRecap(first);
      await ensureRecap(blocker);
      await withinTest(started.promise, signal);
      expect(complete).toHaveBeenCalledTimes(2);
      await ensureRecap(next);
      await ensureRecap(healthy);
      failure.reject(Object.assign(new Error("Overloaded"), { status: 529 }));
      await withinTest(healthyReady.promise, signal);
      expect(view(healthy)?.state).toBe("current");
      expect(complete).toHaveBeenCalledTimes(3);
      expect(view(first)?.state).toBe("updating");
      expect(view(next)?.state).toBe("updating");
      release.resolve(result);
      await vi.advanceTimersByTimeAsync(30_000);
      await withinTest(retried.promise, signal);
      expect(view(first)?.state).toBe("current");
      expect(view(next)?.state).toBe("current");
      const requests = complete.mock.calls.map(
        ([request]) => JSON.parse(request.prompt).messages[0],
      );
      expect(requests.slice(0, 2)).toEqual(
        expect.arrayContaining(["user: Request 1", "user: Request 3"]),
      );
      expect(requests.slice(2)).toEqual(["user: Request 4", "user: Request 2", "user: Request 1"]);
    } finally {
      const disposal = service.dispose();
      failure.resolve(result);
      release.resolve(result);
      await disposal;
    }
  });

  it("stops after bounded retries and starts a fresh retry chain for new work after cooldown", async ({
    signal,
  }) => {
    let retryArmed = createDeferred();
    const time = await restartWithClock(() => retryArmed.resolve());
    const target = await addSession(1);
    fakeTime();
    complete.mockRejectedValue(Object.assign(new Error("Overloaded"), { status: 529 }));
    await ensureRecap(target);
    await withinTest(retryArmed.promise, signal);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(complete).toHaveBeenCalledTimes(attempt);
      // Join each scheduled attempt through retry admission before moving the clock.
      await time.advanceBy(attempt < 4 ? 30_000 * 2 ** (attempt - 1) : 0);
    }
    expect(view(target)?.state).toBe("unavailable");
    await time.advanceBy(3_600_000);
    expect(complete).toHaveBeenCalledTimes(4);
    complete
      .mockResolvedValue(result)
      .mockRejectedValueOnce(Object.assign(new Error("Overloaded again"), { status: 529 }));
    retryArmed = createDeferred();
    await appendWork(target);
    service.handleTranscript({ target: scope(target) });
    await withinTest(retryArmed.promise, signal);
    expect(complete).toHaveBeenCalledTimes(5);
    await time.advanceBy(120_000);
    expect(view(target)?.state).toBe("current");
    expect(complete).toHaveBeenCalledTimes(6);
  });

  it.each([
    Object.assign(new Error("Invalid API key"), { status: 401 }),
    Object.assign(new Error("Insufficient quota; check your billing plan"), { status: 429 }),
    new Error("Isolated completion failed with stop reason error.", {
      cause: { status: 429, message: "Daily request limit exceeded" },
    }),
    Object.assign(new Error("Isolated completion is unsupported"), { code: "unsupported" }),
  ])("does not automatically retry a permanent failure: %s", async (error) => {
    const target = await addSession(1);
    fakeTime();
    complete.mockRejectedValue(error);
    await ensureRecap(target);
    await vi.waitFor(() => expect(view(target)?.state).toBe("unavailable"));
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each(["delete", "dispose"] as const)("cancels a deferred retry on %s", async (action) => {
    const target = await addSession(1);
    fakeTime();
    complete.mockRejectedValueOnce(Object.assign(new Error("Overloaded"), { status: 529 }));
    await ensureRecap(target);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    if (action === "delete") {
      await deleteSessionEntryLifecycle({
        agentId: target.agentId,
        archiveTranscript: false,
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId }),
        target: { canonicalKey: target.key, storeKeys: [target.key] },
      });
    } else {
      await service.dispose();
    }
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(loadSessionEntryReadOnly(scope(target))?.activitySummary).toBeUndefined();
  });
});

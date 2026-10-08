import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../config/sessions/activity-summary.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  SessionTranscriptProjectionUnavailableError,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { seedUnindexedTranscriptForTest } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { isSessionTranscriptIndexReconcileRunning } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
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
import { sessionActivitySummaryHandlers } from "./server-methods/session-activity-summary.js";
import {
  createSessionActivitySummaries,
  type SessionActivitySummaryService,
} from "./session-activity-summaries.js";
import { readActivitySummaryBatch } from "./session-activity-summary-source.js";
import {
  projectSessionActivitySummary,
  type ActivitySummaryTarget,
} from "./session-activity-summary-state.js";
import type { defaultCompleteModel, defaultPrepareModel } from "./session-observer-model.js";

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
    config: cfg,
    agentId,
    provider: "test",
    model: modelRef?.split("/")[1] ?? "utility",
    authProfileId: undefined,
    agentDir: "/tmp/unused",
    outputTextPolicy: "strict-visible",
  });
  const prepare = vi.fn<typeof defaultPrepareModel>();
  const changed = vi.fn();
  const view = (target: ActivitySummaryTarget) =>
    projectSessionActivitySummary({
      ...target,
      cfg,
      entry: loadSessionEntryReadOnly(scope(target)),
    });
  const addSession = async (index: number, agentId = "main") => {
    const target = { agentId, key: `agent:${agentId}:recap-${index}` };
    await upsertSessionEntryCore(scope(target), { sessionId: target.key, updatedAt: 1 });
    await persistSessionTranscriptTurn(scope(target), {
      messages: [
        { eventId: `message-${index}`, message: { role: "user", content: `Request ${index}` } },
      ],
      touchSessionEntry: false,
    });
    return target;
  };
  const appendWork = async (target: ActivitySummaryTarget) => {
    await persistSessionTranscriptTurn(scope(target), {
      messages: [
        {
          eventId: "new-work",
          parentId: "message-1",
          message: { role: "assistant", content: "Verified additional work." },
        },
      ],
      touchSessionEntry: false,
    });
  };
  const fakeTime = () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
  };

  const createService = () =>
    createSessionActivitySummaries({
      scheduler,
      getConfig: () => cfg,
      onChanged: changed,
      prepareModel: prepare,
      completeModel: complete,
    });

  beforeEach(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal" });
    cfg = { agents: { defaults: { utilityModel: "test/utility" } } };
    complete.mockReset().mockResolvedValue(result);
    prepare.mockReset().mockImplementation(prepareModel);
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

    const settled = createDeferred<ReturnType<typeof view>>();
    changed.mockImplementation(() => {
      const summary = view(target);
      if (summary?.state === "current" || summary?.state === "unavailable") {
        settled.resolve(summary);
      }
    });
    service.ensure(target);
    expect(await settled.promise).toMatchObject({ state: "current", text: result.text });
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
    const settled = createDeferred<ReturnType<typeof view>>();
    changed.mockImplementation(() => {
      const summary = view(target);
      if (summary?.state !== "updating") {
        settled.resolve(summary);
      }
    });
    service.ensure(target);
    try {
      await started.promise;
      await patchSessionEntryCore(scope(target), () => ({ category: undefined }), {
        preserveActivity: true,
      });
      preparation.resolve();
      expect(await settled.promise).toMatchObject({ state: "stale" });
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
        service.ensure(target);
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
      await patchSessionEntryCore(
        scope(target),
        (entry) => ({
          activitySummary: {
            ...entry.activitySummary!,
            formatRevision: 2,
            omittedContent: true,
            text: recap + notice,
          },
        }),
        { preserveActivity: true },
      );
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
      await persistSessionTranscriptTurn(scope(target), {
        messages: [
          {
            eventId: "message-3",
            parentId: "message-2",
            message: { role: "assistant", content: "Outcome 3" },
          },
        ],
        touchSessionEntry: false,
      });
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
      service.ensure(target);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      const oldText = "Ran internal_tool and checked the result. Waiting for review.";
      await patchSessionEntryCore(
        scope(target),
        (entry) => ({
          activitySummary: { ...entry.activitySummary!, formatRevision: undefined, text: oldText },
        }),
        { preserveActivity: true },
      );
      if (newWork) {
        await appendWork(target);
      }
      expect(view(target)).toMatchObject({ state: "stale", text: oldText });
      const restyled = createDeferred<typeof result>();
      complete.mockImplementationOnce(() => restyled.promise);
      try {
        expect(service.ensure(target)).toMatchObject({ state: "updating", text: oldText });
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
      service.ensure(target);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      service.ensure(target);
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
      const initial = createDeferred();
      changed.mockImplementation(() => {
        if (view(target)?.state === "current") {
          initial.resolve();
        }
      });
      service.ensure(target);
      await initial.promise;
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
          await persistSessionTranscriptTurn(scope(target), {
            messages: [
              {
                eventId: "continued-work",
                parentId: "new-work",
                message: { role: "assistant", content: "Verified the follow-on work." },
              },
            ],
            touchSessionEntry: false,
          });
          const continued = createDeferred();
          complete.mockImplementationOnce(() => {
            continued.resolve();
            return continuation.promise;
          });
          service.ensure(target);
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
    service.ensure(target);
    await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
    await patchSessionEntryCore(
      scope(target),
      (entry) => ({
        activitySummary: { ...entry.activitySummary!, formatRevision: undefined },
      }),
      { preserveActivity: true },
    );
    complete.mockRejectedValue(new Error("temporary failure"));
    service.ensure(target);
    await vi.waitFor(() => expect(view(target)?.state).toBe("unavailable"));
    for (let index = 0; index < 20; index += 1) {
      service.ensure(target);
    }
    expect(view(target)?.text).toBe(result.text);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("queues a full Activity page and reports admission limits until a slot settles", async ({
    signal,
  }) => {
    const targets: ActivitySummaryTarget[] = [];
    for (let index = 0; index < 257; index += 1) {
      targets.push(await addSession(index));
    }
    const overflow = targets[256]!;
    const initial = createDeferred();
    changed.mockImplementation(() => {
      if (view(overflow)?.state === "current") {
        initial.resolve();
      }
    });
    service.ensure(overflow);
    await withinTest(initial.promise, signal);
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
    const respond = vi.fn();
    const ensure = async (sessions: ActivitySummaryTarget[]) => {
      const params = { sessions };
      await sessionActivitySummaryHandlers["sessions.activitySummary.ensure"]!({
        req: { type: "req", id: "capacity", method: "sessions.activitySummary.ensure", params },
        params,
        context,
        client: null,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond.mock.calls.at(-1)?.[0]).toBe(true);
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
      await ensure([overflow]);
      expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
        sessions: [
          {
            ...overflow,
            activitySummary: { state: "current", text: result.text, canEnsure: true },
          },
        ],
      });
      expect(view(overflow)?.state).toBe("current");
      await persistSessionTranscriptTurn(scope(overflow), {
        messages: [
          {
            eventId: "overflow-new-work",
            parentId: "message-256",
            message: { role: "assistant", content: "Verified additional work." },
          },
        ],
        touchSessionEntry: false,
      });
      await ensure([overflow]);
      expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
        sessions: [
          {
            ...overflow,
            activitySummary: { state: "unavailable", text: result.text, canEnsure: true },
          },
        ],
      });
      expect(complete).toHaveBeenCalledTimes(2);
      first.resolve(result);
      await withinTest(slotReused.promise, signal);
      expect(complete).toHaveBeenCalledTimes(3);
      await ensure([overflow]);
      expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
        sessions: [
          {
            ...overflow,
            activitySummary: { state: "updating", text: result.text, canEnsure: true },
          },
        ],
      });
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

  it.each([
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
    async ({ error, delay }) => {
      const target = await addSession(1);
      service.ensure(target);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      await appendWork(target);
      fakeTime();
      complete.mockRejectedValueOnce(error);
      service.ensure(target);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(0);
      const failedAt = Date.now();
      for (let index = 0; index < 20; index += 1) {
        service.ensure(target);
      }
      expect(view(target)).toMatchObject({ state: "updating", text: result.text });
      await vi.advanceTimersByTimeAsync(delay - 1_000);
      expect(complete).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      expect(Date.now() - failedAt).toBeGreaterThanOrEqual(delay);
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
      service.ensure(first);
      service.ensure(blocker);
      await withinTest(started.promise, signal);
      expect(complete).toHaveBeenCalledTimes(2);
      service.ensure(next);
      service.ensure(healthy);
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

  it.each(["ensure", "new transcript"] as const)(
    "stops after bounded retries and starts a fresh retry chain for %s after cooldown",
    async (trigger) => {
      const target = await addSession(1);
      fakeTime();
      complete.mockRejectedValue(Object.assign(new Error("Overloaded"), { status: 529 }));
      service.ensure(target);
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(attempt));
        await vi.advanceTimersByTimeAsync(attempt < 4 ? 30_000 * 2 ** (attempt - 1) : 0);
      }
      expect(view(target)?.state).toBe("unavailable");
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(complete).toHaveBeenCalledTimes(4);
      complete
        .mockResolvedValue(result)
        .mockRejectedValueOnce(Object.assign(new Error("Overloaded again"), { status: 529 }));
      if (trigger === "ensure") {
        service.ensure(target);
      } else {
        await appendWork(target);
        service.handleTranscript({ target: scope(target) });
      }
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(5));
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      expect(complete).toHaveBeenCalledTimes(6);
    },
  );

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
    service.ensure(target);
    await vi.waitFor(() => expect(view(target)?.state).toBe("unavailable"));
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each(["delete", "dispose"] as const)("cancels a deferred retry on %s", async (action) => {
    const target = await addSession(1);
    fakeTime();
    complete.mockRejectedValueOnce(Object.assign(new Error("Overloaded"), { status: 529 }));
    service.ensure(target);
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

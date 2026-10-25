// Canonical Gateway active-work waiting must report the owners that block shutdown.
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewaySuspendPrepareResultSchema } from "../../packages/gateway-protocol/src/index.js";
import type { EmbeddedAgentQueueHandle } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  createEmbeddedRunHandle,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { scheduleFollowupDrain } from "../auto-reply/reply/queue/drain.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import { clearFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { isFollowupRunAborted, type FollowupRun } from "../auto-reply/reply/queue/types.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../process/command-queue.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewayActiveWorkSnapshot,
  waitForGatewayActiveWork,
} from "./gateway-active-work.js";
import { beginLifecycleWriteCustody } from "./lifecycle-write-custody.js";

const activeRuns = new Map<string, EmbeddedAgentQueueHandle>();

function expectSuspensionWireShape(snapshot: ReturnType<typeof createGatewayActiveWorkSnapshot>) {
  expect(
    Value.Check(GatewaySuspendPrepareResultSchema, {
      status: "draining",
      suspensionId: "held-owner",
      expiresAtMs: 120_000,
      retryAfterMs: 20_000,
      activeCount: snapshot.counts.totalActive,
      blockers: snapshot.blockers,
      writeCustody: snapshot.writeCustody,
    }),
  ).toBe(true);
}

afterEach(() => {
  for (const [sessionId, handle] of activeRuns) {
    clearActiveEmbeddedRun(sessionId, handle);
  }
  activeRuns.clear();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
});

describe("waitForGatewayActiveWork", () => {
  it.each([60, undefined])(
    "waits for process-owned work within the %s ms budget",
    async (timeoutMs) => {
      vi.useFakeTimers();
      const admission = tryBeginGatewayRootWorkAdmission("ws:agent");
      const onSnapshot = vi.fn();
      let settled = false;
      const waiting = waitForGatewayActiveWork(timeoutMs, { onSnapshot }).then((result) => {
        settled = true;
        return result;
      });
      try {
        if (timeoutMs === undefined) {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(settled).toBe(false);
          admission?.release();
          await vi.advanceTimersByTimeAsync(250);
        } else {
          await vi.advanceTimersByTimeAsync(timeoutMs - 1);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
        }
        const result = await waiting;
        expect(result.drained).toBe(timeoutMs === undefined);
        expect(result.snapshot.counts.rootRequests).toBe(timeoutMs === undefined ? 0 : 1);
        expect(onSnapshot).toHaveBeenLastCalledWith(result.snapshot);
      } finally {
        admission?.release();
      }
    },
  );

  it.each(["complete", "cancel"] as const)(
    "reports debounced followup work until its source can %s",
    async (outcome) => {
      vi.useFakeTimers();
      const key = `gateway-active-work-debounce-${outcome}`;
      const run = createQueueTestRun({ prompt: "queued work", messageId: key });
      run.run.sessionKey = key;
      const cancellation = new AbortController();
      run.abortSignal = cancellation.signal;
      const started = createDeferredCore();
      const release = createDeferredCore();
      const execute = vi.fn(async () => {
        started.resolve();
        await release.promise;
      });
      const notifyCancellation = vi.fn();
      const runFollowup = async (source: FollowupRun) => {
        if (isFollowupRunAborted(source)) {
          notifyCancellation();
          return;
        }
        await execute();
      };
      const settings = { mode: "followup", debounceMs: 500 } as const;
      try {
        expect(enqueueFollowupRun(key, run, settings, "message-id", runFollowup, false)).toBe(true);
        // Unscheduled backlog is dormant; the scheduled debounce below owns work.
        expect((await waitForGatewayActiveWork(0)).drained).toBe(true);
        scheduleFollowupDrain(key, runFollowup);
        expect((await waitForGatewayActiveWork(0)).drained).toBe(false);
        expect(execute).not.toHaveBeenCalled();

        if (outcome === "cancel") {
          cancellation.abort();
        } else {
          await vi.advanceTimersByTimeAsync(500);
          await started.promise;
          expect((await waitForGatewayActiveWork(0)).drained).toBe(false);
          release.resolve();
        }
        await run.controllerInput!.settlement.promise;
        await run.controllerInput!.claim?.settlement.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect((await waitForGatewayActiveWork(0)).drained).toBe(true);
        if (outcome === "cancel") {
          expect(notifyCancellation).toHaveBeenCalledOnce();
          expect(execute).not.toHaveBeenCalled();
        } else {
          expect(notifyCancellation).not.toHaveBeenCalled();
          expect(execute).toHaveBeenCalledOnce();
          // Retained dedupe expiry is housekeeping, not runnable work.
          const duplicate = createQueueTestRun({ prompt: "queued work", messageId: key });
          duplicate.run.sessionKey = key;
          expect(enqueueFollowupRun(key, duplicate, settings, "message-id", runFollowup)).toBe(
            false,
          );
          expect((await waitForGatewayActiveWork(0)).drained).toBe(true);
        }
      } finally {
        release.resolve();
        clearFollowupQueue(key);
        await run.controllerInput?.settlement.promise;
      }
    },
  );

  it("returns the final canonical blockers when its deadline expires", async () => {
    const sessionId = "probe-gateway-active-work-timeout";
    const handle = createEmbeddedRunHandle();
    activeRuns.set(sessionId, handle);
    setActiveEmbeddedRun(sessionId, handle);

    const result = await waitForGatewayActiveWork(0);

    expect(result.drained).toBe(false);
    expect(result.snapshot.counts.embeddedRuns).toBe(1);
    expect(result.snapshot.blockers).toContainEqual({
      kind: "embedded-run",
      count: 1,
      message: "1 active embedded run(s)",
    });
  });

  it("names the command lane holding queued work", async () => {
    const lane = "shutdown-queued-owner";
    const cancellation = new AbortController();
    const reason = new Error("queued owner stopped");
    setCommandLaneConcurrency(lane, 0);
    const queued = enqueueCommandInLane(lane, async () => {}, { abortSignal: cancellation.signal });
    const rejected = expect(queued).rejects.toBe(reason);
    try {
      const result = await waitForGatewayActiveWork(0);
      expect(result.snapshot.blockers).toContainEqual({
        kind: "queue",
        count: 1,
        message: `1 queued or active operation(s): ${lane} (active=0, queued=1)`,
      });
    } finally {
      cancellation.abort(reason);
      await rejected;
    }
  });

  it("publishes native owners and separate write custody through the suspension wire shape", () => {
    const release = beginLifecycleWriteCustody("migration");
    try {
      const snapshot = createGatewayActiveWorkSnapshot({
        getRootRequests: () => 2,
        getCronRuns: () => 3,
        getSessionMutations: () => 1,
        getTerminalPersistence: () => 1,
        getBackgroundExecSessions: () => 1,
        getAgentRuns: () => 1,
        getAcpRuns: () => 2,
        getMediaRuns: () => 3,
      });
      expect(snapshot.writeCustody).toEqual([
        { phase: "migration", count: 1 },
        { phase: "session-mutation", count: 1 },
        { phase: "terminal-persistence", count: 1 },
      ]);
      expect(snapshot).toMatchObject({
        idle: false,
        counts: {
          rootRequests: 2,
          cronRuns: 3,
          lifecycleWrites: 1,
          backgroundExecSessions: 1,
          agentRuns: 1,
          acpRuns: 2,
          mediaRuns: 3,
          totalActive: 15,
        },
      });
      expect(snapshot.blockers.map(({ kind }) => kind)).toEqual([
        "background-exec",
        "cron-run",
        "agent-run",
        "acp-run",
        "media-generation",
        "root-request",
        "session-mutation",
        "terminal-persistence",
      ]);
      expectSuspensionWireShape(snapshot);
    } finally {
      release();
    }
    expect(createGatewayActiveWorkSnapshot().writeCustody).toEqual([]);
  });

  it.each([
    [
      ["ws:sessions.subscribe", "cron:timer-tick", "ws:sessions.subscribe"],
      undefined,
      "3 active gateway request(s): cron:timer-tick, ws:sessions.subscribe (2)",
    ],
    [
      Array.from({ length: 10 }, (_, index) => `request-${index}`),
      undefined,
      "10 active gateway request(s): request-0, request-1, request-2, request-3, request-4, request-5, request-6, request-7, +2 more",
    ],
    [["ws:agent"], 1, "1 active gateway request(s)"],
  ] as const)(
    "reports root holders %j with count override %s",
    async (holders, override, message) => {
      const admissions = holders.map((holder) => tryBeginGatewayRootWorkAdmission(holder));
      try {
        const snapshot = override
          ? createGatewayActiveWorkSnapshot({ getRootRequests: () => 1 })
          : (await waitForGatewayActiveWork(0)).snapshot;
        expect(snapshot.blockers).toContainEqual({
          kind: "root-request",
          count: override ?? holders.length,
          message,
        });
      } finally {
        for (const admission of admissions) {
          admission?.release();
        }
      }
    },
  );
});

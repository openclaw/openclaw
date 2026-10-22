import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { onGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { listActiveReplyRunSessionKeys } from "../sessions/session-controller.queries.js";
import { getSessionControllerOperation } from "../sessions/session-controller.state.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  markCronJobActive,
  clearCronJobActive,
  hasActiveCronJobsForAgent,
  markCronJobWaitingForIdle,
  resetCronActiveJobs,
} from "./active-jobs.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { isCronExecutionIdle } from "./execution-idle.js";
import { createNoopLogger } from "./service.test-harness.js";
import { waitForCronExecutionIdle } from "./service/execution-idle.js";
import { createCronServiceState } from "./service/state.js";

const operations: ReplyOperation[] = [];
afterEach(() => {
  resetCronActiveJobs();
  for (const operation of operations.splice(0)) {
    operation.complete();
  }
});
const idleJob = makeCronJob({ agentId: "main", idleOnly: true, sessionTarget: "isolated" });

describe("idle-only execution admission", () => {
  it("resumes distinct same-agent on-exit reply owners serially after foreground work settles", async ({
    signal,
  }) => {
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath: "unused-idle-owner-store",
      cronEnabled: true,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      isExecutionIdle: (job, ownSessionKey, ownReplyOperation) =>
        isCronExecutionIdle({}, job, "main", ownSessionKey, ownReplyOperation),
    });
    const foreground = createReplyOperation({
      sessionKey: "agent:main:foreground",
      sessionId: "foreground",
      resetTriggered: false,
      turnKind: "visible",
    });
    operations.push(foreground);
    const owners = ["first", "second"].map((id) => {
      const sessionKey = `agent:main:on-exit:${id}`;
      const operation = createReplyOperation({
        sessionKey,
        sessionId: id,
        resetTriggered: false,
        turnKind: "queued_followup",
      });
      operations.push(operation);
      const job = makeCronJob({
        id,
        agentId: "main",
        idleOnly: true,
        sessionTarget: `session:${sessionKey}`,
        schedule: { kind: "on-exit", command: `observed-${id}` },
      });
      const marker = expectDefined(
        markCronJobActive(job.id, { agentId: "main" }),
        "on-exit marker",
      );
      return { operation, job, marker };
    });
    const bothWaiting = createDeferred();
    const firstStarted = createDeferred<string>();
    const releaseFirst = createDeferred();
    const order: string[] = [];
    const unsubscribe = onGatewayWorkMetricsChanged(() => {
      if (owners.every(({ marker }) => marker.idleAdmissionWait)) {
        bothWaiting.resolve();
      }
    });
    const cancellation = new AbortController();
    const activeSignal = AbortSignal.any([signal, cancellation.signal]);
    const pending = Promise.all(
      owners.map(async ({ operation, job, marker }) => {
        try {
          await waitForCronExecutionIdle(state, job, {
            activeJobMarker: marker,
            ownSessionKey: operation.key,
            ownReplyOperation: operation,
            signal: activeSignal,
            assertCurrent: () => {
              operation.abortSignal.throwIfAborted();
              if (getSessionControllerOperation(operation.key) !== operation) {
                throw new Error("On-exit reply owner was replaced");
              }
            },
          });
          order.push(`start:${job.id}`);
          if (order.length === 1) {
            firstStarted.resolve(job.id);
            await releaseFirst.promise;
          }
          order.push(`finish:${job.id}`);
        } finally {
          operation.complete();
          clearCronJobActive(job.id, marker);
        }
      }),
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          bothWaiting.promise,
          pending,
          "Both on-exit owners must remain pending",
        ),
        signal,
      );
      expect(order).toEqual([]);
      expect(owners.every(({ marker }) => marker.idleAdmissionWait)).toBe(true);
      expect(hasActiveCronJobsForAgent("main")).toBe(true);
      expect(listActiveReplyRunSessionKeys().toSorted()).toEqual(
        [foreground.key, ...owners.map(({ operation }) => operation.key)].toSorted(),
      );
      foreground.complete();
      const first = await withinTest(
        awaitGateBeforeSettlement(firstStarted.promise, pending, "Idle reply owners deadlocked"),
        signal,
      );
      expect(order).toEqual([`start:${first}`]);
      expect(hasActiveCronJobsForAgent("main")).toBe(true);
      releaseFirst.resolve();
      await withinTest(pending, signal);
      const second = expectDefined(
        owners.find(({ job }) => job.id !== first),
        "second on-exit owner",
      ).job.id;
      expect(order).toEqual([
        `start:${first}`,
        `finish:${first}`,
        `start:${second}`,
        `finish:${second}`,
      ]);
      expect(listActiveReplyRunSessionKeys()).toEqual([]);
      expect(hasActiveCronJobsForAgent("main")).toBe(false);
    } finally {
      unsubscribe();
      cancellation.abort();
      releaseFirst.resolve();
      foreground.complete();
      await Promise.allSettled([pending]);
    }
  });

  it.for(["peer", "own"] as const)(
    "keeps a %s successor at a waiting session key visible to idle admission",
    async (replacement) => {
      const own = createReplyOperation({
        sessionKey: "agent:main:own-wait",
        sessionId: "own-wait",
        resetTriggered: false,
        turnKind: "queued_followup",
      });
      const peer = createReplyOperation({
        sessionKey: "agent:main:peer-wait",
        sessionId: "peer-wait",
        resetTriggered: false,
        turnKind: "queued_followup",
      });
      operations.push(own, peer);
      const ownMarker = markCronJobActive(idleJob.id, { agentId: "main" });
      const peerMarker = markCronJobActive("peer", { agentId: "main" });
      const endOwnWait = markCronJobWaitingForIdle(ownMarker, own);
      const endPeerWait = markCronJobWaitingForIdle(peerMarker, peer);
      try {
        expect(isCronExecutionIdle({}, idleJob, "main", own.key, own)).toBe(true);
        const previous = replacement === "own" ? own : peer;
        previous.complete();
        operations.push(
          createReplyOperation({
            sessionKey: previous.key,
            sessionId: `foreground-${replacement}`,
            resetTriggered: false,
            turnKind: "visible",
          }),
        );
        expect(isCronExecutionIdle({}, idleJob, "main", own.key, own)).toBe(false);
        expect(hasActiveCronJobsForAgent("main")).toBe(true);
      } finally {
        endPeerWait();
        endOwnWait();
      }
    },
  );

  it("observes foreground admission before backend registration, including another conversation", () => {
    expect(isCronExecutionIdle({}, idleJob, "main")).toBe(true);
    operations.push(
      createReplyOperation({
        sessionKey: "agent:main:chat:foreground",
        sessionId: "foreground",
        resetTriggered: false,
        turnKind: "visible",
      }),
    );
    expect(isCronExecutionIdle({}, idleJob, "main")).toBe(false);
    expect(operations[0]!.abortSignal.aborted).toBe(false);
  });

  it("waits for other same-agent automation work without treating itself or siblings as busy", () => {
    const own = markCronJobActive(idleJob.id, { agentId: "main" });
    markCronJobActive("sibling-job", { agentId: "other" });
    expect(isCronExecutionIdle({}, idleJob, "main")).toBe(true);
    const script = markCronJobActive("script-job", { agentId: "main" });
    expect(isCronExecutionIdle({}, idleJob, "main")).toBe(false);
    clearCronJobActive("script-job", script);
    expect(isCronExecutionIdle({}, idleJob, "main")).toBe(true);
    clearCronJobActive(idleJob.id, own);
  });

  it("keeps idle waiters drain-visible without making them block another idle admission", () => {
    const waiting = markCronJobActive("waiting-exit", { agentId: "main" });
    expect(isCronExecutionIdle({}, idleJob, "main")).toBe(false);
    const ready = markCronJobWaitingForIdle(waiting);
    expect(isCronExecutionIdle({}, idleJob, "main")).toBe(true);
    expect(hasActiveCronJobsForAgent("main")).toBe(true);
    ready();
    expect(isCronExecutionIdle({}, idleJob, "main")).toBe(false);
    clearCronJobActive("waiting-exit", waiting);
    expect(isCronExecutionIdle({}, idleJob, "main")).toBe(true);
    expect(hasActiveCronJobsForAgent("main")).toBe(false);
  });

  it("excludes only its own controller operation at the runner-entry recheck", () => {
    const ownSessionKey = "agent:main:cron:check:run:one";
    const own = createReplyOperation({
      sessionKey: ownSessionKey,
      sessionId: "native-own",
      resetTriggered: false,
      turnKind: "visible",
    });
    operations.push(
      own,
      createReplyOperation({
        sessionKey: "agent:other:main",
        sessionId: "native-other",
        resetTriggered: false,
        turnKind: "visible",
      }),
    );
    expect(isCronExecutionIdle({}, idleJob, "main", ownSessionKey, own)).toBe(true);
    operations.push(
      createReplyOperation({
        sessionKey: "agent:main:chat:foreground",
        sessionId: "native-foreground",
        resetTriggered: false,
        turnKind: "visible",
      }),
    );
    expect(isCronExecutionIdle({}, idleJob, "main", ownSessionKey, own)).toBe(false);
  });
});

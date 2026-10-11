import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { listActiveEmbeddedRunSessionKeys } from "../agents/embedded-agent-runner/active-run-projections.js";
import {
  setActiveEmbeddedRun,
  clearActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  createReplyOperation,
  replyRunRegistry,
  type ReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import { onGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
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
import { runWithCronAdmission } from "./service/run-admission-capacity.js";
import { createCronServiceState } from "./service/state.js";

const embedded: Array<{
  sessionId: string;
  sessionKey: string;
  handle: ReturnType<typeof createEmbeddedRunHandle>;
}> = [];
function registerEmbeddedRun(sessionKey: string) {
  const sessionId = `native:${sessionKey}`;
  const handle = createEmbeddedRunHandle({ runId: sessionId });
  setActiveEmbeddedRun(sessionId, handle, sessionKey);
  embedded.push({ sessionId, sessionKey, handle });
}

const operations: ReplyOperation[] = [];
afterEach(() => {
  resetCronActiveJobs();
  for (const operation of operations.splice(0)) {
    operation.complete();
  }
  for (const { sessionId, sessionKey, handle } of embedded.splice(0)) {
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
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
        turnKind: "background",
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
      owners.map(({ operation, job, marker }) =>
        runWithCronAdmission(
          state,
          async () => {
            try {
              await waitForCronExecutionIdle(state, job, {
                activeJobMarker: marker,
                ownSessionKey: operation.key,
                ownReplyOperation: operation,
                signal: activeSignal,
                assertCurrent: () => {
                  operation.abortSignal.throwIfAborted();
                  if (replyRunRegistry.get(operation.key) !== operation) {
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
          },
          undefined,
          activeSignal,
        ),
      ),
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
      expect(state.runAdmission.active).toBe(0);
      expect(hasActiveCronJobsForAgent("main")).toBe(true);
      expect(listActiveEmbeddedRunSessionKeys()).toEqual(
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
      expect(listActiveEmbeddedRunSessionKeys()).toEqual([]);
      expect(hasActiveCronJobsForAgent("main")).toBe(false);
    } finally {
      unsubscribe();
      cancellation.abort();
      releaseFirst.resolve();
      foreground.complete();
      await Promise.allSettled([pending]);
    }
  });

  it.for(["peer", "own", "native"] as const)(
    "keeps a %s successor at a waiting session key visible to idle admission",
    async (replacement) => {
      const own = createReplyOperation({
        sessionKey: "agent:main:own-wait",
        sessionId: "own-wait",
        resetTriggered: false,
        turnKind: "background",
      });
      const peer = createReplyOperation({
        sessionKey: "agent:main:peer-wait",
        sessionId: "peer-wait",
        resetTriggered: false,
        turnKind: "background",
      });
      operations.push(own, peer);
      const ownMarker = markCronJobActive(idleJob.id, { agentId: "main" });
      const peerMarker = markCronJobActive("peer", { agentId: "main" });
      const endOwnWait = markCronJobWaitingForIdle(ownMarker, own);
      const endPeerWait = markCronJobWaitingForIdle(peerMarker, peer);
      try {
        expect(isCronExecutionIdle({}, idleJob, "main", own.key, own)).toBe(true);
        if (replacement === "native") {
          registerEmbeddedRun(peer.key);
        } else {
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
        }
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

  it("excludes only its own backend at the runner-entry recheck", () => {
    const ownSessionKey = "agent:main:cron:check:run:one";
    registerEmbeddedRun(ownSessionKey);
    registerEmbeddedRun("agent:other:main");
    expect(isCronExecutionIdle({}, idleJob, "main", ownSessionKey)).toBe(true);
    registerEmbeddedRun("agent:main:chat:foreground");
    expect(isCronExecutionIdle({}, idleJob, "main", ownSessionKey)).toBe(false);
  });
});

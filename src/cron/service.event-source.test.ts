import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { observeCronJobCommits } from "../../test/helpers/cron/runtime-mutation.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createChannelIngressDrain } from "../channels/message/ingress-drain.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import * as workerAdmission from "../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { CronEventInput } from "./event-source.js";
import { CronService } from "./service.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import { locked } from "./service/locked.js";
import {
  commitCronRunRequests,
  drainCronRunQueue,
  getCronRunQueueRequests,
} from "./service/run-queue.js";
import type { CronServiceDeps } from "./service/state.js";
import * as cronStore from "./store.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob, CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-event-source-" });

async function fixture(overrides: Partial<CronServiceDeps> = {}) {
  const { storePath } = await makeStorePath();
  const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
    status: "ok",
  }));
  const { cron, state } = createCronServiceWithStateForTest({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    nowMs: () => Date.now(),
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob,
    ...overrides,
  });
  await cron.start();
  const input: CronJobCreate = {
    name: "event handler",
    enabled: true,
    schedule: {
      kind: "event",
      source: "mcp-events",
      options: { server: "test", name: "changed", arguments: { a: 1, b: 2 } },
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Summarize the received change.", toolsAllow: ["read"] },
  };
  const job = await cron.add(input);
  const queue = createChannelIngressQueue<CronEventInput>({
    channelId: "mcp-events",
    accountId: job.id,
    now: () => Date.now(),
  });
  async function claim(
    eventId: string,
    target: CronJob = job,
    payload: unknown = { text: "original event" },
  ) {
    const sourceIdentity = target.state.sourceIdentity;
    if (!sourceIdentity) {
      throw new Error("missing source generation");
    }
    const event: CronEventInput = {
      jobId: target.id,
      sourceIdentity,
      eventId,
      receivedAtMs: Date.now(),
      payload,
    };
    await queue.enqueue(eventId, event, { laneKey: job.id });
    const claimed = await queue.claim(eventId);
    if (!claimed) {
      throw new Error("event was not claimed");
    }
    return {
      event,
      options: {
        sourceIdentity,
        eventId,
        receivedAtMs: event.receivedAtMs,
        payload: event.payload,
        claim: { queueName: claimed.queueName, id: claimed.id, token: claimed.claim.token },
        commitGuard: () => {},
      },
    };
  }
  return { cron, state, job, input, queue, claim, storePath, runIsolatedAgentJob };
}

async function waitForEventRun(
  cron: CronService,
  result: Awaited<ReturnType<CronService["runEvent"]>>,
) {
  expect(result.kind).toBe("transferred");
  if (result.kind !== "transferred") {
    throw new Error("expected an admitted event run");
  }
  expect(await cron.waitForManualRun(result.runId, 5_000)).toBe(true);
}

describe("event automation durable admission", () => {
  it("atomically transfers ingress to one receipt, preserving instructions and creator policy while busy", async () => {
    const started = createDeferredCore();
    const finish = createDeferredCore();
    const calls: Parameters<CronServiceDeps["runIsolatedAgentJob"]>[0][] = [];
    const schedulerScope = new AsyncLocalStorage<boolean>();
    const executionScopes: Array<boolean | undefined> = [];
    const f = await fixture({
      runSchedulerOwned: (run) => schedulerScope.run(true, run),
      runIsolatedAgentJob: async (params) => {
        executionScopes.push(schedulerScope.getStore());
        calls.push(params);
        started.resolve();
        await finish.promise;
        return { status: "error", error: "synthetic downstream failure" };
      },
    });
    try {
      const payload = { text: "original event" };
      const first = await f.claim("first", f.job, payload);
      const run = f.cron.runEvent(f.job.id, first.options);
      payload.text = "caller mutation must not enter the turn";
      const receipt = await run;
      expect(receipt.kind).toBe("transferred");
      await started.promise;
      expect(executionScopes).toEqual([true]);
      expect(calls[0]?.message).toContain("Summarize the received change.");
      expect(calls[0]?.message).toContain("EXTERNAL_UNTRUSTED_CONTENT");
      expect(calls[0]?.message).toContain("original event");
      expect(calls[0]?.message).not.toContain("caller mutation");
      expect(calls[0]?.job.payload.toolsAllow).toEqual(["read"]);
      expect(calls[0]?.job.scheduledToolPolicy).toEqual({ version: 1, mode: "trusted" });
      const duplicate = await f.queue.enqueue("first", first.event);
      expect(duplicate).toMatchObject({
        kind: "completed",
        record: {
          metadata: {
            jobId: f.job.id,
            eventId: "first",
            receiptId: receipt.kind === "transferred" ? receipt.receiptId : "missing",
          },
        },
      });
      const second = await f.claim("second");
      expect(await f.cron.runEvent(f.job.id, second.options)).toEqual({
        kind: "pending",
        reason: "busy",
      });
      expect(await f.queue.listClaims()).toMatchObject([{ attempts: 0 }]);
      finish.resolve();
      await waitForEventRun(f.cron, receipt);
      expect(
        await f.cron.runEvent(f.job.id, { ...first.options, payload: { text: "original event" } }),
      ).toEqual({ kind: "invalidated" });
      await waitForEventRun(f.cron, await f.cron.runEvent(f.job.id, second.options));
      expect(calls).toHaveLength(2);
      const persisted = (await loadCronStore(f.storePath)).jobs[0];
      expect(persisted?.state.nextRunAtMs).toBeUndefined();
      expect(persisted?.state.lastRunStatus).toBe("error");
      expect(persisted?.payload).toEqual(f.job.payload);
    } finally {
      finish.resolve();
      await f.cron.waitForIdle();
      f.cron.stop();
    }
  });

  it("keeps untransferred event claims out of the scheduler's unguarded drain", async () => {
    const f = await fixture();
    try {
      const { event, options } = await f.claim("scheduler-event");
      const transferred = vi.fn();
      const requested = await locked(f.state, () =>
        commitCronRunRequests(f.state, [f.job], {
          source: "manual",
          mode: "if-enabled",
          event: { input: event, claim: options.claim },
          commitGuard: options.commitGuard,
          onEventTransferred: transferred,
        }),
      );
      expect(requested).toHaveLength(1);
      expect(getCronRunQueueRequests(f.state)).toEqual([]);
      expect(getCronRunQueueRequests(f.state, { includePendingEvents: true })).toMatchObject([
        { receiptId: requested[0]!.runReceipt.receiptId, event: { input: event } },
      ]);
      // Exercise the native scheduler composition, not just its host projection.
      const scheduled = await executeOpenClawStateWorker(captureOpenClawStateWorkerContext(), {
        type: "cron.schedulerTick",
        input: {
          storeKey: cronStoreKey(f.storePath),
          nowMs: Date.now(),
          requests: getCronRunQueueRequests(f.state),
        },
      });
      expect(scheduled.launches).toEqual([]);
      expect(transferred).not.toHaveBeenCalled();
      expect(f.runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(await f.queue.listClaims()).toMatchObject([
        { id: event.eventId, claim: { token: options.claim.token } },
      ]);
      await drainCronRunQueue(f.state);
      await requested[0]!.completion;
      expect(transferred).toHaveBeenCalledOnce();
      expect(f.runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect(await f.queue.enqueue(event.eventId, event)).toMatchObject({ kind: "completed" });
    } finally {
      f.cron.stop();
      await f.cron.waitForIdle();
    }
  });

  it("admits a full 256-KiB webhook body plus adapter metadata while independently bounding payload and metadata", async () => {
    const f = await fixture();
    try {
      const body = JSON.stringify({ data: "x".repeat(262_133) });
      expect(Buffer.byteLength(body, "utf8")).toBe(262_144);
      const payload = { bindingId: "adapter-binding", event: JSON.parse(body) };
      const { options } = await f.claim("max-wire-event", f.job, payload);
      await waitForEventRun(f.cron, await f.cron.runEvent(f.job.id, options));
      expect(f.runIsolatedAgentJob).toHaveBeenCalledOnce();
      await expect(
        f.cron.runEvent(f.job.id, { ...options, payload: "x".repeat(1_048_576) }),
      ).rejects.toThrow("oversized automation event");
      await expect(
        f.cron.runEvent(f.job.id, { ...options, eventId: "x".repeat(65_536) }),
      ).rejects.toThrow("oversized automation event");
      expect(f.runIsolatedAgentJob).toHaveBeenCalledOnce();
    } finally {
      f.cron.stop();
    }
  });

  it.each(["partition lock", "store load"] as const)(
    "keeps a queued event pending across a stop and restart at the %s",
    async (boundary) => {
      const f = await fixture();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let updating: Promise<unknown> | undefined;
      let restarting: Promise<void> | undefined;
      let eventRun: ReturnType<CronService["runEvent"]> | undefined;
      try {
        const { options } = await f.claim("restart-pending");
        if (boundary === "partition lock") {
          updating = f.cron.updateWithPrecondition(f.job.id, { name: "blocked edit" }, async () => {
            entered.resolve();
            await release.promise;
          });
          void updating.catch(() => {});
          await entered.promise;
        } else {
          cronStore.noteCronJobsStoreCommit(cronStoreKey(f.storePath));
          const load = cronStore.loadCronJobsStoreWithConfigJobs;
          const delayed = vi
            .spyOn(cronStore, "loadCronJobsStoreWithConfigJobs")
            .mockImplementationOnce(async (...args) => {
              const loaded = await load(...args);
              entered.resolve();
              await release.promise;
              return loaded;
            });
          onTestFinished(() => delayed.mockRestore());
        }
        eventRun = f.cron.runEvent(f.job.id, options);
        const outcome = eventRun.then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        if (boundary === "store load") {
          await awaitGateBeforeSettlement(
            entered.promise,
            eventRun,
            "event admission did not reload",
          );
        }
        f.cron.stop();
        restarting = f.cron.start();
        release.resolve();
        expect(await outcome).toEqual({ result: { kind: "pending", reason: "stopped" } });
        await Promise.allSettled([updating, restarting]);
        expect(await f.queue.listClaims()).toMatchObject([
          { id: "restart-pending", attempts: 0, claim: { token: options.claim.token } },
        ]);
        expect(f.runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(f.cron.getJob(f.job.id)?.state.queuedAtMs).toBeUndefined();
        expect(f.cron.getJob(f.job.id)?.state.runningReceiptId).toBeUndefined();
      } finally {
        release.resolve();
        await Promise.allSettled([updating, eventRun, restarting]);
        f.cron.stop();
        await f.cron.waitForIdle();
      }
    },
  );

  it("keeps paused work pending and fences disable/enable and same-definition A-B-A sources", async () => {
    const cronConfig = { triggers: { enabled: true } };
    const f = await fixture({ cronConfig });
    try {
      const { options } = await f.claim("fenced");
      await f.cron.add({
        ...f.input,
        name: "unrelated timer",
        schedule: { kind: "every", everyMs: 60_000 },
      });
      expect((await f.cron.listPage({ scheduleKind: "event" })).jobs.map((job) => job.id)).toEqual([
        f.job.id,
      ]);
      const snapshots = await f.cron.readEventSources("mcp-events");
      snapshots[0]!.options.server = "mutated";
      expect((await f.cron.readEventSources("mcp-events"))[0]?.options.server).toBe("test");
      expect(await f.cron.readEventSources("another-plugin")).toEqual([]);
      f.cron.pauseScheduling();
      expect((await f.cron.readEventSources("mcp-events"))[0]?.enabled).toBe(true);
      expect(await f.cron.runEvent(f.job.id, options)).toEqual({
        kind: "pending",
        reason: "paused",
      });
      f.cron.resumeScheduling();
      cronConfig.triggers.enabled = false;
      expect(await f.cron.runEvent(f.job.id, options)).toEqual({
        kind: "pending",
        reason: "paused",
      });
      await expect(f.cron.add({ ...f.input, name: "blocked source" })).rejects.toThrow(
        "cron.triggers.enabled: false",
      );
      cronConfig.triggers.enabled = true;
      f.cron.stop();
      await f.cron.waitForIdle();
      expect(await f.cron.runEvent(f.job.id, options)).toEqual({
        kind: "pending",
        reason: "stopped",
      });
      expect(await f.queue.listClaims()).toMatchObject([{ attempts: 0 }]);
      await f.cron.start();
      const equivalent = await f.cron.update(f.job.id, {
        schedule: {
          kind: "event",
          source: "mcp-events",
          options: { arguments: { b: 2, a: 1 }, name: "changed", server: "test" },
        },
      });
      expect(equivalent.state.sourceIdentity).toBe(f.job.state.sourceIdentity);
      await f.cron.update(f.job.id, { enabled: false });
      await f.cron.update(f.job.id, { enabled: true });
      expect(await f.cron.runEvent(f.job.id, options)).toEqual({ kind: "invalidated" });
      const before = await f.cron.readJob(f.job.id);
      await f.cron.update(f.job.id, {
        schedule: { kind: "event", source: "mcp-events", options: { server: "B" } },
      });
      const restored = await f.cron.update(f.job.id, { schedule: f.input.schedule });
      expect(restored.state.sourceIdentity).not.toBe(before?.state.sourceIdentity);
      expect(f.runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(await f.queue.listClaims()).toHaveLength(1);
    } finally {
      f.cron.stop();
    }
  });

  it("rolls back activation when ingress transfer fails, leaving the original payload recoverable", async () => {
    const f = await fixture();
    const db = openOpenClawStateDatabase().db;
    try {
      const { event, options } = await f.claim("rollback-event");
      db.exec(
        "CREATE TRIGGER reject_event_transfer BEFORE UPDATE OF status ON channel_ingress_events WHEN NEW.event_id = 'rollback-event' AND NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'event transfer blocked'); END;",
      );
      await expect(f.cron.runEvent(f.job.id, options)).rejects.toThrow("event transfer blocked");
      expect(f.runIsolatedAgentJob).not.toHaveBeenCalled();
      expect((await f.queue.listClaims())[0]?.payload).toEqual(event);
      expect((await f.cron.readJob(f.job.id))?.state.queuedAtMs).toBeUndefined();
      expect((await f.cron.readJob(f.job.id))?.state.runningAtMs).toBeUndefined();
      db.exec("DROP TRIGGER reject_event_transfer");
      await waitForEventRun(f.cron, await f.cron.runEvent(f.job.id, options));
      expect(f.runIsolatedAgentJob).toHaveBeenCalledOnce();
    } finally {
      db.exec("DROP TRIGGER IF EXISTS reject_event_transfer");
      await f.cron.waitForIdle();
      f.cron.stop();
    }
  });

  it("rolls back the receipt and ingress together when source authority closes at activation commit", async () => {
    const f = await fixture();
    const { event, options } = await f.claim("commit-revoked");
    const createAdmission = workerAdmission.createSqliteWorkerWriteAdmission;
    let revoke = false;
    const admission = vi
      .spyOn(workerAdmission, "createSqliteWorkerWriteAdmission")
      .mockImplementation((assertCurrent, locations, attachment) =>
        createAdmission(
          (request) => {
            if (
              request.stage === "commit" &&
              f.cron.getJob(f.job.id)?.state.queuedAtMs !== undefined
            ) {
              revoke = true;
            }
            assertCurrent(request);
          },
          locations,
          attachment,
        ),
      );
    try {
      await expect(
        f.cron.runEvent(f.job.id, {
          ...options,
          commitGuard() {
            if (revoke) {
              throw new Error("source retired at activation commit");
            }
          },
        }),
      ).rejects.toThrow("source retired at activation commit");
      expect(f.runIsolatedAgentJob).not.toHaveBeenCalled();
      expect((await f.queue.listClaims())[0]?.payload).toEqual(event);
      const job = await f.cron.readJob(f.job.id);
      expect(job?.state.queuedAtMs).toBeUndefined();
      expect(job?.state.runningAtMs).toBeUndefined();
      admission.mockRestore();
      await waitForEventRun(f.cron, await f.cron.runEvent(f.job.id, options));
      expect(f.runIsolatedAgentJob).toHaveBeenCalledOnce();
    } finally {
      admission.mockRestore();
      f.cron.stop();
      await f.cron.waitForIdle();
    }
  });

  it("does not cancel or dead-letter another source when one event guard fails at batch commit", async () => {
    const f = await fixture();
    const sibling = await f.cron.add({ ...f.input, name: "valid sibling source" });
    const jobs = [f.job, sibling];
    const queues = [
      f.queue,
      createChannelIngressQueue<CronEventInput>({
        channelId: "mcp-events",
        accountId: sibling.id,
      }),
    ];
    const events = jobs.map((job, index): CronEventInput => {
      if (!job.state.sourceIdentity) {
        throw new Error("missing event source identity");
      }
      return {
        jobId: job.id,
        sourceIdentity: job.state.sourceIdentity,
        eventId: "source-" + index,
        receivedAtMs: Date.now(),
        payload: { index },
      };
    });
    const ready = createDeferredCore();
    const begin = createDeferredCore();
    const revoked = new Error("source A revoked");
    let entered = 0;
    let sourceARevoked = false;
    const transferred: Array<Awaited<ReturnType<CronService["runEvent"]>>> = [];
    // Match a source adapter's non-retryable revocation policy, using the real
    // ingress drain and Cron request/activation owners rather than mocked runs.
    const drains = queues.map((queue, index) =>
      createChannelIngressDrain({
        queue,
        deriveLaneKey: (record) => record.payload.jobId,
        resolveNonRetryableFailure: (error) =>
          error === revoked ? { reason: "source_revoked", message: revoked.message } : null,
        dispatchClaimedEvent: async (claim) => {
          if (++entered === 2) {
            ready.resolve();
          }
          await begin.promise;
          const { jobId, ...input } = claim.payload;
          const result = await f.cron.runEvent(jobId, {
            ...input,
            claim: { queueName: claim.queueName, id: claim.id, token: claim.claim.token },
            commitGuard() {
              if (index === 0 && sourceARevoked) {
                throw revoked;
              }
            },
          });
          if (result.kind === "transferred") {
            transferred.push(result);
            return { kind: "transferred" };
          }
          if (result.kind === "pending") {
            return { kind: "pending" };
          }
          throw new Error("unexpected source invalidation");
        },
      }),
    );
    const createAdmission = workerAdmission.createSqliteWorkerWriteAdmission;
    const admission = vi
      .spyOn(workerAdmission, "createSqliteWorkerWriteAdmission")
      .mockImplementation((assertCurrent, locations, attachment) =>
        createAdmission(
          (request) => {
            if (
              request.stage === "commit" &&
              jobs.every((job) => f.cron.getJob(job.id)?.state.queuedAtMs !== undefined)
            ) {
              sourceARevoked = true;
            }
            assertCurrent(request);
          },
          locations,
          attachment,
        ),
      );
    try {
      await Promise.all(
        queues.map((queue, index) => queue.enqueue(events[index]!.eventId, events[index]!)),
      );
      await Promise.all(drains.map((drain) => drain.drainOnce()));
      await ready.promise;
      begin.resolve();
      await Promise.all(drains.map((drain) => drain.waitForIdle()));
      await Promise.all(transferred.map((result) => waitForEventRun(f.cron, result)));
      expect(sourceARevoked).toBe(true);
      expect(f.runIsolatedAgentJob.mock.calls.map(([params]) => params.job.id)).toEqual([
        sibling.id,
      ]);
      expect(await queues[0]!.listFailed?.()).toMatchObject([{ reason: "source_revoked" }]);
      expect(await queues[1]!.listFailed?.()).toEqual([]);
      expect(await queues[1]!.listClaims()).toEqual([]);
      expect(await queues[1]!.enqueue(events[1]!.eventId, events[1]!)).toMatchObject({
        kind: "completed",
        record: { metadata: { jobId: sibling.id } },
      });
    } finally {
      begin.resolve();
      await Promise.all(drains.map((drain) => drain.waitForIdle()));
      admission.mockRestore();
      for (const drain of drains) {
        drain.dispose();
      }
      f.cron.stop();
      await f.cron.waitForIdle();
    }
  });

  it("rejects changed payloads, foreign plugin claims, and source revocation before activation", async () => {
    const f = await fixture();
    try {
      const { event, options } = await f.claim("guarded-event");
      expect(
        await f.cron.runEvent(f.job.id, { ...options, payload: { instructions: "changed" } }),
      ).toEqual({ kind: "invalidated" });
      const foreign = createChannelIngressQueue<CronEventInput>({
        channelId: "another-plugin",
        accountId: f.job.id,
      });
      await foreign.enqueue("guarded-event", event);
      const claim = await foreign.claim("guarded-event");
      if (!claim) {
        throw new Error("missing foreign claim");
      }
      expect(
        await f.cron.runEvent(f.job.id, {
          ...options,
          claim: { queueName: claim.queueName, id: claim.id, token: claim.claim.token },
        }),
      ).toEqual({ kind: "invalidated" });
      await expect(
        f.cron.runEvent(f.job.id, {
          ...options,
          commitGuard() {
            if (f.cron.getJob(f.job.id)?.state.queuedAtMs !== undefined) {
              throw new Error("source revoked after reservation");
            }
          },
        }),
      ).rejects.toThrow("source revoked after reservation");
      expect(f.runIsolatedAgentJob).not.toHaveBeenCalled();
      expect((await f.queue.listClaims())[0]?.payload).toEqual(event);
      await waitForEventRun(f.cron, await f.cron.runEvent(f.job.id, options));
      expect(f.runIsolatedAgentJob).toHaveBeenCalledOnce();
    } finally {
      await f.cron.waitForIdle();
      f.cron.stop();
    }
  });

  it("rejects a replaced ingress claim after reservation without consuming its successor", async () => {
    const f = await fixture();
    const reserved = createDeferredCore();
    const release = createDeferredCore();
    let editing: Promise<unknown> | undefined;
    const stopObserving = observeCronJobCommits(f.job.id, (state) => {
      if (state.queuedAtMs !== undefined && !editing) {
        // Hold the real partition after request commit and before queue activation.
        editing = f.cron.updateWithPrecondition(f.job.id, { name: "held source" }, async () => {
          reserved.resolve();
          await release.promise;
        });
        void editing.catch(() => {});
      }
    });
    let pending: ReturnType<CronService["runEvent"]> | undefined;
    try {
      const { options } = await f.claim("replaced-claim");
      pending = f.cron.runEvent(f.job.id, options);
      await awaitGateBeforeSettlement(
        reserved.promise,
        pending,
        "event admission settled before its reservation",
      );
      expect(
        await f.queue.release(
          { id: options.claim.id, claim: { token: options.claim.token } },
          { recordAttempt: false },
        ),
      ).toBe(true);
      const successor = await f.queue.claim(options.claim.id);
      if (!successor) {
        throw new Error("missing successor claim");
      }
      release.resolve();
      await editing;
      expect(await pending).toEqual({ kind: "invalidated" });
      expect(f.runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(await f.queue.listClaims()).toMatchObject([
        {
          attempts: 0,
          claim: { token: successor.claim.token },
        },
      ]);
      expect((await f.cron.readJob(f.job.id))?.state.queuedAtMs).toBeUndefined();
      await waitForEventRun(
        f.cron,
        await f.cron.runEvent(f.job.id, {
          ...options,
          claim: { ...options.claim, token: successor.claim.token },
        }),
      );
      expect(f.runIsolatedAgentJob).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      stopObserving();
      await Promise.allSettled([editing, pending]);
      await f.cron.waitForIdle();
      f.cron.stop();
      await f.cron.waitForIdle();
    }
  });

  it("records authenticated creator authority even when operator input omits toolsAllow", async () => {
    const f = await fixture();
    try {
      const owner = { sessionKey: "agent:main:creator", accountId: "creator-account" };
      const policy = {
        version: 1 as const,
        mode: "account" as const,
        ownerSessionKey: owner.sessionKey,
        ownerAccountId: owner.accountId,
      };
      const created = await f.cron.add(
        {
          ...f.input,
          name: "account event",
          owner,
          payload: { kind: "agentTurn", message: "Keep creator policy." },
        },
        { scheduledToolPolicy: policy },
      );
      const persisted = (await loadCronStore(f.storePath)).jobs.find(
        (job) => job.id === created.id,
      );
      expect(persisted?.payload.toolsAllow).toEqual(["*"]);
      expect(persisted?.scheduledToolPolicy).toEqual(policy);
      expect(persisted?.owner).toMatchObject(owner);
      expect(created.state.nextRunAtMs).toBeUndefined();
    } finally {
      f.cron.stop();
    }
  });
});

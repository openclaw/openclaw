import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../test/helpers/cron/runtime-mutation.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createCronStreamWatchers } from "../gateway/cron-stream-watchers.js";
import { fakeSupervisor } from "../gateway/cron-stream-watchers.test-helpers.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  readCronRunHistoryPageForTests,
  readCronRunRecordsForTests,
} from "./run-history.test-support.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import * as runtimeMutation from "./service/runtime-mutation.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronJobsStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import * as runHistory from "./store/run-history.js";
import { cronStreamScheduleKey } from "./stream-schedule.js";
import type { CronJob } from "./types.js";

async function withStreamService(
  run: (fixture: {
    service: CronService;
    job: CronJob;
    storePath: string;
    source: { scheduleKey: string; identity: string };
    setDefaultAgent: (agentId: string | undefined) => void;
    enqueueSessionEvent: ReturnType<
      typeof vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>
    >;
    onEvent: ReturnType<typeof vi.fn<NonNullable<CronServiceDeps["onEvent"]>>>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "cron-stream-worker" }, async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    let defaultAgentId: string | undefined = "alpha";
    const enqueueSessionEvent = vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>();
    const onEvent = vi.fn<NonNullable<CronServiceDeps["onEvent"]>>();
    const service = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => 1_000,
      storePath,
      cronEnabled: true,
      defaultAgentId: "alpha",
      resolveDefaultAgentId: () => defaultAgentId,
      cronConfig: {
        triggers: { enabled: true },
        failureAlert: { enabled: true, after: 5, cooldownMs: 0 },
      },
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      enqueueSessionEvent,
      runIsolatedAgentJob: async () => ({ status: "ok" }),
      onEvent,
    });
    try {
      const added = await service.add({
        name: "stream worker",
        enabled: true,
        schedule: { kind: "stream", command: ["synthetic-stream-source"] },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "handle synthetic events" },
      });
      const job = "job" in added ? added.job : added;
      if (job.schedule.kind !== "stream") {
        throw new Error("Expected the created stream schedule");
      }
      const source = {
        scheduleKey: cronStreamScheduleKey(job.schedule),
        identity: expectDefined(job.state.streamSourceIdentity, "created stream identity"),
      };
      await service.readJob(job.id);
      defaultAgentId = undefined;
      onEvent.mockClear();
      await run({
        service,
        job,
        storePath,
        source,
        setDefaultAgent: (agentId) => {
          defaultAgentId = agentId;
        },
        enqueueSessionEvent,
        onEvent,
      });
    } finally {
      service.stop();
    }
  });
}

describe("cron stream worker service", () => {
  it("commits all four external operations without caller-thread SQL", async () => {
    await withStreamService(async ({ service, job, storePath, source }) => {
      const sql = observeMainThreadSql();
      const measure = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
        sql.clear();
        const result = await operation();
        expect.soft(sql.count(), label).toBe(0);
        return result;
      };
      let retiredIdentity: string | undefined;
      try {
        sql.calibrate();
        expect(
          await measure("external state", () =>
            service.updateExternalState(job.id, source.scheduleKey, source.identity, {
              streamStatus: "running",
            }),
          ),
        ).toBe(true);
        await measure("external counters", () =>
          service.updateExternalCounters(job.id, {
            streamDroppedBatches: 7,
            streamCoalescedBatches: 3,
          }),
        );
        retiredIdentity = await measure("source retirement", () =>
          service.retireExternalStreamSource(job.id, source.scheduleKey, source.identity),
        );
        expect(retiredIdentity).toEqual(expect.any(String));
        expect(retiredIdentity).not.toBe(source.identity);
        await measure("external failure", () =>
          service.recordExternalFailure(
            job.id,
            "source exhausted restarts",
            { streamStatus: "error", streamRestartExhausted: true },
            { ...source, identity: expectDefined(retiredIdentity, "retired stream identity") },
          ),
        );
      } finally {
        sql.restore();
      }
      const expectedState = {
        streamSourceIdentity: retiredIdentity,
        streamDroppedBatches: 7,
        streamCoalescedBatches: 3,
        streamStatus: "error",
        streamRestartExhausted: true,
        consecutiveErrors: 5,
        lastError: "source exhausted restarts",
      };
      expect(readCronRunRecordsForTests(job.id)).toEqual([
        expect.objectContaining({ agentId: "alpha" }),
      ]);
      expect(service.getJob(job.id)?.state).toMatchObject(expectedState);
      expect(
        (await loadCronJobsStore(storePath)).jobs.find((row) => row.id === job.id)?.state,
      ).toMatchObject(expectedState);
    });
  });

  it.each(["agent", "stop"] as const)(
    "rejects %s supersession while an external write waits for the public lock",
    async (supersession) => {
      await withStreamService(async ({ service, job, storePath, source, setDefaultAgent }) => {
        const entered = createDeferred();
        const release = createDeferred();
        const blockerError = new Error("fixture released the lock without changing the job");
        const blocker = service
          .updateWithPrecondition(job.id, {}, async () => {
            entered.resolve();
            await release.promise;
            throw blockerError;
          })
          .catch((error: unknown) => error);
        let pending: Promise<unknown> | undefined;
        try {
          await entered.promise;
          pending = service
            .updateExternalState(job.id, source.scheduleKey, source.identity, {
              streamStatus: "error",
            })
            .then(
              (value) => ({ kind: "returned", value }),
              (error: unknown) => ({ kind: "rejected", error }),
            );
          if (supersession === "stop") {
            service.stop();
          } else {
            setDefaultAgent("beta");
          }
          release.resolve();
          expect(await blocker).toBe(blockerError);
          expect(await pending).toMatchObject({
            kind: "rejected",
            error: { message: "Cron mutation source or service changed before commit" },
          });
          expect(service.getJob(job.id)?.state.streamStatus).toBeUndefined();
          expect(
            (await loadCronJobsStore(storePath)).jobs.find((row) => row.id === job.id)?.state
              .streamStatus,
          ).toBeUndefined();
        } finally {
          release.resolve();
          await blocker;
          await pending;
        }
      });
    },
  );

  it("preserves shutdown failure while adopting the committed retirement identity after reply loss", async () => {
    await withStreamService(async ({ service, job, storePath, source, setDefaultAgent }) => {
      setDefaultAgent("alpha");
      const fake = fakeSupervisor();
      const scheduler = createTestGatewayScheduler();
      const updateState = vi.fn(
        (id: string, patch: Partial<CronJob["state"]>, scheduleKey: string, identity: string) =>
          service.updateExternalState(id, scheduleKey, identity, patch),
      );
      let dropped: ReturnType<typeof loseFirstCronMutationReply> | undefined;
      let retirementFailure: unknown;
      const retireSource = vi.fn(async (id: string, scheduleKey: string, identity: string) => {
        const loss = loseFirstCronMutationReply("cron.mutateExternalState");
        dropped = loss;
        try {
          return await service.retireExternalStreamSource(id, scheduleKey, identity);
        } catch (error) {
          retirementFailure = error;
          throw error;
        } finally {
          await loss.close();
        }
      });
      const watchers = createCronStreamWatchers({
        getDefaultAgentId: () => service.getDefaultAgentId(),
        scheduler,
        getProcessSupervisor: () => fake.supervisor,
        updateState,
        retireSource,
        updateCounters: (id, counters) => service.updateExternalCounters(id, counters),
        recordFailure: (id, error, patch, scheduleKey, identity) =>
          service.recordExternalFailure(id, error, patch, { scheduleKey, identity }),
        fireBatch: async () => "fired",
        logger: createNoopLogger(),
      });
      try {
        await watchers.start(job);
        expect(fake.spawn).toHaveBeenCalledOnce();
        expect(watchers.inspect(job.id)).toMatchObject({
          state: "running",
          sourceIdentity: source.identity,
          processAlive: true,
        });
        expect(
          (await loadCronJobsStore(storePath)).jobs.find((row) => row.id === job.id)?.state
            .streamStatus,
        ).toBe("running");
        updateState.mockClear();
        const stopping = await watchers.stop(job.id, "shutdown").then(
          () => ({ kind: "stopped" }),
          (error: unknown) => ({ kind: "rejected", error }),
        );
        const loss = expectDefined(dropped, "actual retirement reply loss");
        expect(loss.wasDropped()).toBe(true);
        expect(loss.attempts).toEqual(["cron.mutateExternalState"]);
        expect(retireSource).toHaveBeenCalledExactlyOnceWith(
          job.id,
          source.scheduleKey,
          source.identity,
        );
        const stored = expectDefined(
          (await loadCronJobsStore(storePath)).jobs.find((row) => row.id === job.id),
          "durable retired stream job",
        );
        const retiredIdentity = expectDefined(
          stored.state.streamSourceIdentity,
          "committed identity",
        );
        expect(retiredIdentity).not.toBe(source.identity);
        expect.soft(watchers.inspect(job.id)).toMatchObject({
          state: "stopped",
          sourceIdentity: retiredIdentity,
          processAlive: false,
        });
        expect
          .soft(updateState)
          .toHaveBeenCalledExactlyOnceWith(
            job.id,
            { streamStatus: "stopped", streamError: undefined },
            source.scheduleKey,
            retiredIdentity,
          );
        const stoppedState = { streamStatus: "stopped", streamSourceIdentity: retiredIdentity };
        expect.soft(stored.state).toMatchObject(stoppedState);
        expect.soft(service.getJob(job.id)?.state).toMatchObject(stoppedState);
        expect(retirementFailure).toBeInstanceOf(Error);
        expect(stopping).toEqual({ kind: "rejected", error: retirementFailure });
      } finally {
        try {
          await watchers.stopAll("schedule-update");
        } finally {
          await scheduler.stop();
          await dropped?.close();
        }
      }
    });
  });

  it.each([
    {
      name: "retains durable failure state without publishing after worker reply loss",
      loseReply: true,
    },
    {
      name: "rejects source retirement during committed failure history without publishing it",
      loseReply: false,
    },
  ])("$name", async ({ loseReply }) => {
    await withStreamService(
      async ({
        service,
        job,
        storePath,
        source,
        setDefaultAgent,
        enqueueSessionEvent,
        onEvent,
      }) => {
        const historyEntered = createDeferred();
        const releaseHistory = createDeferred();
        const record = runHistory.recordCronRun;
        const history = vi
          .spyOn(runHistory, "recordCronRun")
          .mockImplementation(async (...args) => {
            historyEntered.resolve();
            await releaseHistory.promise;
            return record(...args);
          });
        let dropped: ReturnType<typeof loseFirstCronMutationReply> | undefined;
        const execute = runtimeMutation.runCronRuntimeMutation;
        const mutation = loseReply
          ? vi
              .spyOn(runtimeMutation, "runCronRuntimeMutation")
              .mockImplementationOnce(async (params) => {
                dropped = loseFirstCronMutationReply(params.type);
                return execute(params);
              })
          : undefined;
        const residentBefore = structuredClone(service.getJob(job.id)?.state);
        const expectedState = {
          lastRunStatus: "error",
          consecutiveErrors: 5,
          streamRestartExhausted: true,
          lastError: "source exhausted restarts",
        };
        let settled = false;
        const pending = service
          .recordExternalFailure(
            job.id,
            "source exhausted restarts",
            { streamStatus: "error", streamRestartExhausted: true },
            source,
          )
          .then(
            () => ({ kind: "returned" }),
            (error: unknown) => ({ kind: "rejected", error }),
          )
          .finally(() => {
            settled = true;
          });
        try {
          if (loseReply) {
            expect(await pending).toMatchObject({ kind: "rejected" });
            const loss = expectDefined(dropped, "actual external-state worker mutation");
            expect(loss.wasDropped()).toBe(true);
            expect(loss.attempts).toHaveLength(1);
            await loss.waitForExit();
            expect(history).not.toHaveBeenCalled();
            expect(enqueueSessionEvent).not.toHaveBeenCalled();
            expect(
              onEvent.mock.calls.filter(([event]) => event.action === "finished"),
            ).toHaveLength(0);
            expect(service.getJob(job.id)?.state).toEqual(residentBefore);
            expect(
              (await loadCronJobsStore(storePath)).jobs.find((row) => row.id === job.id)?.state,
            ).toMatchObject(expectedState);
            return;
          }
          expect(
            await Promise.race([
              historyEntered.promise.then(() => "history-entered"),
              pending.then(() => "operation-settled-before-history"),
            ]),
          ).toBe("history-entered");
          expect(settled).toBe(false);
          expect(enqueueSessionEvent).not.toHaveBeenCalled();
          expect(onEvent.mock.calls.filter(([event]) => event.action === "finished")).toHaveLength(
            0,
          );
          expect(
            (await loadCronJobsStore(storePath)).jobs.find((row) => row.id === job.id)?.state,
          ).toMatchObject(expectedState);
          setDefaultAgent("beta");
          releaseHistory.resolve();
          const outcome = await pending;
          expect(outcome).toMatchObject({ kind: "rejected" });
          expect(history).toHaveBeenCalledTimes(1);
          expect(outcome).toMatchObject({
            error: { message: "Cron mutation source or service changed before commit" },
          });
          expect(
            readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
              .entries,
          ).toEqual([]);
          expect(enqueueSessionEvent).not.toHaveBeenCalled();
          expect(onEvent.mock.calls.filter(([event]) => event.action === "finished")).toHaveLength(
            0,
          );
          expect(service.getJob(job.id)?.state).toEqual(residentBefore);
          expect(
            (await loadCronJobsStore(storePath)).jobs.find((row) => row.id === job.id)?.state,
          ).toMatchObject(expectedState);
        } finally {
          releaseHistory.resolve();
          await pending;
          await dropped?.close();
          history.mockRestore();
          mutation?.mockRestore();
        }
      },
    );
  });
});

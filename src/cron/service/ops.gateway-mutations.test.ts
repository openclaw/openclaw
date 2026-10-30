import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import * as gatewayModule from "../../agents/tools/gateway.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "../../agents/tools/in-process-gateway.js";
import { loadCronStore } from "../../cron/store.js";
import * as gatewayProcess from "../../gateway/process-instance.js";
import { getTotalQueueSize } from "../../process/command-queue.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  occupyWorkers,
  readJob,
  withCronGatewayState,
  type CronGatewayFixture,
} from "./ops.gateway.test-support.js";
import type { CronServiceDeps } from "./state.js";

type CallerClosure = "revoked" | "aborted";
type CallerFixture = CronGatewayFixture & {
  closeCaller: (closure: CallerClosure) => void;
  call: AgentToolGatewayRequestCaller;
};
const jobInput = {
  name: "joined Cron mutation",
  agentId: "main",
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "fixture work" },
  delivery: { mode: "none" },
} as const;

async function withCronGateway(
  run: (fixture: CallerFixture) => Promise<void>,
  listConfiguredChannels?: CronServiceDeps["listConfiguredChannels"],
) {
  await withCronGatewayState(
    async (fixture) => {
      const controller = new AbortController();
      let current = true;
      const caller = {
        agentId: "main",
        sessionKey: "agent:main:cron-mutation-fixture",
        operationalRunInstance: { instanceId: "cron-mutation-fixture", runId: "fixture-run" },
        receiptAuthority: () => current,
        gatewayContextResolver: () => fixture.context,
      };
      await run({
        ...fixture,
        closeCaller: (closure) => {
          if (closure === "aborted") {
            controller.abort(new Error("Cron request aborted"));
          } else {
            current = false;
          }
        },
        call: <T>(request: Parameters<AgentToolGatewayRequestCaller>[0]) =>
          withGatewayToolCallerIdentity(caller, () =>
            callAgentToolGatewayRequest<T>({ ...request, signal: controller.signal }),
          ),
      });
    },
    listConfiguredChannels,
    true,
  );
}

describe("Cron mutation outcomes through the in-process router", () => {
  it("persists the current timezone on expression-only tool edits, including revision conflicts", async () => {
    await withCronGateway(async (fixture) => {
      const job = await fixture.cron.add({
        name: "morning brief",
        description: "Synthetic timezone regression",
        enabled: true,
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Synthetic brief" },
      });
      const calls: string[] = [];
      let concurrentTimezone: string | undefined;
      const gatewaySpy = vi
        .spyOn(gatewayModule, "callGatewayTool")
        .mockImplementation(async <T>(method: string, _opts: unknown, params: unknown) => {
          calls.push(method);
          if (method === "cron.update" && concurrentTimezone) {
            const tz = concurrentTimezone;
            concurrentTimezone = undefined;
            // Commit a real competing edit after cron.get, before the guarded write.
            await fixture.call({
              method: "cron.update",
              params: { id: job.id, patch: { schedule: { ...job.schedule, tz } } },
            });
          }
          return await fixture.call<T>({ method, params });
        });
      onTestFinished(() => gatewaySpy.mockRestore());
      const tool = createCronTool();
      for (const tz of ["Asia/Shanghai", "Europe/Paris"]) {
        calls.length = 0;
        concurrentTimezone = tz === "Europe/Paris" ? tz : undefined;
        await tool.execute("edit-time", {
          action: "update",
          jobId: job.id,
          job: { schedule: { kind: "cron", expr: "0 9 * * *" } },
        });
        await fixture.settle();
        const persisted = await readJob(fixture, job.id);
        expect(persisted).toMatchObject({
          name: job.name,
          description: job.description,
          payload: job.payload,
          schedule: { kind: "cron", expr: "0 9 * * *", tz },
        });
        expect(calls).toEqual(
          tz === "Asia/Shanghai"
            ? ["cron.get", "cron.update"]
            : ["cron.get", "cron.update", "cron.get", "cron.update"],
        );
      }
      expect(fixture.runIsolatedAgentJob).not.toHaveBeenCalled();
    });
  });

  it.each(["execute", "revoke", "abort", "stop"] as const)(
    "retains caller cleanup only through accepted manual admission: %s",
    async (outcome) => {
      await withCronGateway(async (fixture) => {
        const now = Date.now();
        const job = createDueIsolatedJob({ id: "retained-tool-run", nowMs: now, nextRunAtMs: now });
        const payloadStarted = createDeferredCore();
        const releasePayload = createDeferredCore();
        const cleanupFinished = createDeferredCore();
        const releaseResources = vi.fn(() => {
          fixture.closeCaller("aborted");
          cleanupFinished.resolve();
        });
        const { blocker, releaseBlocker, targetCalls } = await occupyWorkers(
          fixture,
          job,
          async () => {
            payloadStarted.resolve();
            await releasePayload.promise;
            return { status: "ok" };
          },
        );
        try {
          const ack = await runWithAsyncWorkResources(async (onAcquired) => {
            onAcquired({ release: releaseResources });
            return await fixture.call({
              method: "cron.run",
              params: { id: job.id, mode: "force" },
            });
          });
          expect(ack).toMatchObject({ ok: true, enqueued: true });
          expect(releaseResources).not.toHaveBeenCalled();
          expect(targetCalls()).toHaveLength(0);
          if (outcome === "revoke") {
            fixture.closeCaller("revoked");
          }
          if (outcome === "abort") {
            fixture.closeCaller("aborted");
          }
          if (outcome === "stop") {
            fixture.cron.stop();
          }
          releaseBlocker.resolve();
          await blocker;
          if (outcome === "execute") {
            await payloadStarted.promise;
            // Admission is finished: cleanup must not wait for the separately
            // owned automation payload, which can itself wait on caller work.
            await cleanupFinished.promise;
            expect(releaseResources).toHaveBeenCalledOnce();
            expect(targetCalls()).toHaveLength(1);
          }
          releasePayload.resolve();
          const terminal = await fixture.finished(job.id);
          await cleanupFinished.promise;
          expect(terminal.status).toBe(outcome === "execute" ? "ok" : "skipped");
          if (outcome !== "execute") {
            expect(targetCalls()).toHaveLength(0);
          }
          expect(releaseResources).toHaveBeenCalledOnce();
          expect((await readJob(fixture, job.id))?.state.queuedAtMs).toBeUndefined();
        } finally {
          releaseBlocker.resolve();
          releasePayload.resolve();
          await blocker;
        }
      });
    },
  );

  it.each(["revoked", "aborted"] as const)(
    "leaves durable state unchanged when its caller is %s during validation",
    async (closure) => {
      const validating = createDeferredCore();
      const resumeValidation = createDeferredCore();
      await withCronGateway(
        async (fixture) => {
          const before = await loadCronStore(fixture.storePath);
          const pending = fixture.call({ method: "cron.add", params: jobInput });
          try {
            await Promise.race([
              validating.promise,
              pending.then(() => {
                throw new Error("Cron mutation returned before its validation boundary");
              }),
            ]);
            fixture.closeCaller(closure);
            resumeValidation.resolve();
            await expect(pending).rejects.toThrow(
              closure === "aborted" ? "Cron request aborted" : /authority.*no longer active/i,
            );
            // A rejected request alone does not prove its handler stopped before writing.
            await fixture.settle();
            expect(await loadCronStore(fixture.storePath)).toEqual(before);
            expect(fixture.runIsolatedAgentJob).not.toHaveBeenCalled();
          } finally {
            resumeValidation.resolve();
            await Promise.allSettled([pending]);
          }
        },
        async () => {
          validating.resolve();
          await resumeValidation.promise;
          return [];
        },
      );
    },
  );

  it.each([
    { closure: "revoked", reportingError: false },
    { closure: "aborted", reportingError: true },
  ] as const)(
    "preserves committed state and outcome when $closure after commit (reporting error: $reportingError)",
    async ({ closure, reportingError }) => {
      await withCronGateway(async (fixture) => {
        const failure = new Error("Cron post-commit reporting failed");
        let committedBoundaryObserved = false;
        fixture.logger.info.mockImplementation((_details, message) => {
          if (message !== "cron: job added") {
            return;
          }
          // This service notification follows the real store commit.
          committedBoundaryObserved = true;
          fixture.closeCaller(closure);
          if (reportingError) {
            throw failure;
          }
        });
        const pending = fixture.call({ method: "cron.add", params: jobInput });
        if (reportingError) {
          await expect(pending).rejects.toBe(failure);
        } else {
          await expect(pending).resolves.toMatchObject({
            id: expect.any(String),
            name: jobInput.name,
          });
        }
        expect(committedBoundaryObserved).toBe(true);
        const stored = await loadCronStore(fixture.storePath);
        expect(stored.jobs).toHaveLength(1);
        expect(stored.jobs[0]).toMatchObject({
          id: expect.any(String),
          name: jobInput.name,
          payload: jobInput.payload,
        });
      });
    },
  );

  it.each([true, false])(
    "preserves a revoked caller's response only for actual queue acceptance: %s",
    async (accepted) => {
      await withCronGateway(async (fixture) => {
        const now = Date.now();
        const job = createDueIsolatedJob({
          id: "joined-queued-run",
          nowMs: now,
          nextRunAtMs: accepted ? now : now + 60_000,
        });
        const { blocker, releaseBlocker, targetCalls } = await occupyWorkers(fixture, job);
        const processInstanceId = gatewayProcess.getGatewayProcessInstanceId();
        let responseBoundaryObserved = false;
        const processId = vi
          .spyOn(gatewayProcess, "getGatewayProcessInstanceId")
          .mockImplementation(() => {
            // cron.run reads this response field after its real enqueueRun returns.
            responseBoundaryObserved = true;
            fixture.closeCaller("revoked");
            return processInstanceId;
          });
        try {
          const pending = fixture.call({
            method: "cron.run",
            params: { id: job.id, mode: accepted ? "force" : "due" },
          });
          if (accepted) {
            await expect(pending).resolves.toMatchObject({
              ok: true,
              enqueued: true,
              runId: expect.any(String),
              processInstanceId,
            });
          } else {
            await expect(pending).rejects.toThrow(/authority.*no longer active/i);
          }
          expect(responseBoundaryObserved).toBe(true);
          const queuedAtMs = (await readJob(fixture, job.id))?.state.queuedAtMs;
          if (accepted) {
            expect(queuedAtMs).toEqual(expect.any(Number));
          } else {
            expect(queuedAtMs).toBeUndefined();
          }
          expect(targetCalls()).toHaveLength(0);
        } finally {
          processId.mockRestore();
          releaseBlocker.resolve();
          await blocker;
          await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0));
        }
        if (accepted) {
          await expect(fixture.finished(job.id)).resolves.toMatchObject({
            jobId: job.id,
            status: "skipped",
            error: expect.stringMatching(/authority.*no longer active/i),
          });
        }
        expect(targetCalls()).toHaveLength(0);
        expect((await readJob(fixture, job.id))?.state.queuedAtMs).toBeUndefined();
      });
    },
  );
});

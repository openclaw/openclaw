import { describe, expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "../../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService, type CronEvent } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronServiceDeps } from "../../cron/service/state.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../gateway/methods/registry.js";
import * as gatewayProcess from "../../gateway/process-instance.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  getTotalQueueSize,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { CommandLane } from "../../process/lanes.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

type CallerClosure = "revoked" | "aborted";
type CronGatewayFixture = {
  storePath: string;
  logger: ReturnType<typeof createNoopLogger>;
  closeCaller: (closure: CallerClosure) => void;
  call: AgentToolGatewayRequestCaller;
  settle: () => Promise<void>;
  runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"];
  finished: ReturnType<typeof createDeferredCore<CronEvent>>;
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
  run: (fixture: CronGatewayFixture) => Promise<void>,
  listConfiguredChannels?: CronServiceDeps["listConfiguredChannels"],
) {
  await withOpenClawTestState({ prefix: "cron-mutation-dispatch-" }, async (state) => {
    resetCommandQueueStateForTest();
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main" }], defaults: { workspace: state.workspaceDir } },
      cron: { enabled: false },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronStore(storePath, { version: 1, jobs: [] });
    const logger = createNoopLogger();
    const finished = createDeferredCore<CronEvent>();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      listConfiguredChannels,
      onEvent: (event) => {
        if (event.action === "finished") {
          finished.resolve(event);
        }
      },
    });
    const registry = createGatewayMethodRegistry(createCoreGatewayMethodDescriptors(cronHandlers));
    const gatewayWork = new AsyncWorkScope();
    const context = {
      cron,
      cronStorePath: storePath,
      trackExecution: gatewayWork.track.bind(gatewayWork),
      deps: {},
      getRuntimeConfig: () => cfg,
      getGatewayMethodRegistry: () => registry,
      logGateway: createNoopLogger(),
    } as unknown as GatewayRequestContext;
    context.resolveGatewayContext = () => context;
    const controller = new AbortController();
    let current = true;
    const caller = {
      agentId: "main",
      sessionKey: "agent:main:cron-mutation-fixture",
      operationalRunInstance: { instanceId: "cron-mutation-fixture", runId: "fixture-run" },
      receiptAuthority: () => current,
      gatewayContextResolver: () => context,
    };
    try {
      await run({
        storePath,
        logger,
        runIsolatedAgentJob,
        finished,
        settle: () => gatewayWork.runWhenIdle(() => undefined),
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
    } finally {
      cron.stop();
      await gatewayWork.drain();
      await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0));
      resetCommandQueueStateForTest();
    }
  });
}

describe("Cron mutation outcomes through the in-process router", () => {
  it.each(["execute", "revoke", "abort", "clear queue"] as const)(
    "retains caller cleanup only through accepted manual admission: %s",
    async (outcome) => {
      await withCronGateway(async (fixture) => {
        const now = Date.now();
        const job = createDueIsolatedJob({ id: "retained-tool-run", nowMs: now, nextRunAtMs: now });
        await saveCronStore(fixture.storePath, { version: 1, jobs: [job] });
        setCommandLaneConcurrency(CommandLane.Cron, 1);
        const blockerStarted = createDeferredCore();
        const releaseBlocker = createDeferredCore();
        const payloadStarted = createDeferredCore();
        const releasePayload = createDeferredCore();
        const cleanupFinished = createDeferredCore();
        const releaseResources = vi.fn(() => {
          fixture.closeCaller("aborted");
          cleanupFinished.resolve();
        });
        vi.mocked(fixture.runIsolatedAgentJob).mockImplementation(async () => {
          payloadStarted.resolve();
          await releasePayload.promise;
          return { status: "ok" };
        });
        const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
          blockerStarted.resolve();
          await releaseBlocker.promise;
        });
        await blockerStarted.promise;
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
          expect(fixture.runIsolatedAgentJob).not.toHaveBeenCalled();
          if (outcome === "revoke") {
            fixture.closeCaller("revoked");
          }
          if (outcome === "abort") {
            fixture.closeCaller("aborted");
          }
          if (outcome === "clear queue") {
            clearCommandLane(CommandLane.Cron);
          }
          releaseBlocker.resolve();
          await blocker;
          if (outcome === "execute") {
            await payloadStarted.promise;
            // Admission is finished: cleanup must not wait for the separately
            // owned automation payload, which can itself wait on caller work.
            await cleanupFinished.promise;
            expect(releaseResources).toHaveBeenCalledOnce();
            expect(fixture.runIsolatedAgentJob).toHaveBeenCalledOnce();
          }
          releasePayload.resolve();
          const terminal = await fixture.finished.promise;
          await cleanupFinished.promise;
          expect(terminal.status).toBe(outcome === "execute" ? "ok" : "error");
          if (outcome !== "execute") {
            expect(fixture.runIsolatedAgentJob).not.toHaveBeenCalled();
          }
          expect(releaseResources).toHaveBeenCalledOnce();
          expect(
            (await loadCronStore(fixture.storePath)).jobs[0]?.state.queuedAtMs,
          ).toBeUndefined();
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
    { closure: "aborted", reportingError: false },
    { closure: "revoked", reportingError: true },
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
        await saveCronStore(fixture.storePath, { version: 1, jobs: [job] });
        setCommandLaneConcurrency(CommandLane.Cron, 1);
        const blockerStarted = createDeferredCore();
        const releaseBlocker = createDeferredCore();
        const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
          blockerStarted.resolve();
          await releaseBlocker.promise;
        });
        await blockerStarted.promise;
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
          expect(getCommandLaneSnapshot(CommandLane.Cron).queuedCount).toBe(accepted ? 1 : 0);
          expect(fixture.runIsolatedAgentJob).not.toHaveBeenCalled();
        } finally {
          processId.mockRestore();
          releaseBlocker.resolve();
          await blocker;
          await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0));
        }
        if (accepted) {
          await expect(fixture.finished.promise).resolves.toMatchObject({
            jobId: job.id,
            status: "error",
            error: expect.stringMatching(/authority.*no longer active/i),
          });
        }
        expect(fixture.runIsolatedAgentJob).not.toHaveBeenCalled();
        expect((await loadCronStore(fixture.storePath)).jobs[0]?.state.queuedAtMs).toBeUndefined();
      });
    },
  );
});

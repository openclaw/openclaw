import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { wrapToolWithAbortSignal } from "../../agents/agent-tools.abort.js";
import type { OpenClawCodingToolsOptions } from "../../agents/agent-tools.options.js";
import type { AnyAgentTool } from "../../agents/agent-tools.types.js";
import { prepareEmbeddedRunPermissionChange } from "../../agents/embedded-agent-runner/run-permissions.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  createDefaultEmbeddedSession,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "../../agents/embedded-agent-runner/run/attempt-spawn-workspace.test-support.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import { wrapToolWithGatewayCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "../../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService, type CronEvent } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../gateway/methods/registry.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { getTotalQueueSize } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

describe("native attempt queued automation admission", () => {
  beforeAll(preloadRunEmbeddedAttemptForTests);
  beforeEach(() => resetEmbeddedAttemptHarness());
  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each([
    "execute",
    "abort",
    "owner abort",
    "abort before completion",
    "permission change",
    "revoke",
    "stop",
  ] as const)(
    "retains its real tool generation until activation, not payload completion: %s",
    async (outcome) => {
      await withOpenClawTestState({ prefix: "native-cron-admission-" }, async (state) => {
        resetCommandQueueStateForTest();
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
          cron: { enabled: false },
        };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const storePath = state.statePath("cron", "jobs.json");
        const now = Date.now();
        const job = createDueIsolatedJob({ id: "native-queued-run", nowMs: now, nextRunAtMs: now });
        const blockerJobs = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, (_, index) =>
          createDueIsolatedJob({ id: `capacity-${index}`, nowMs: now, nextRunAtMs: now }),
        );
        await saveCronStore(storePath, { version: 1, jobs: [...blockerJobs, job] });
        const blockersStarted = createDeferredCore();
        const releaseBlocker = createDeferredCore();
        let startedBlockers = 0;
        const finished = createDeferredCore<CronEvent>();
        const payloadStarted = createDeferredCore();
        const releasePayload = createDeferredCore();
        const generationReleased = createDeferredCore();
        const cleanup = vi.fn(async () => {
          generationReleased.resolve();
        });
        const runIsolatedAgentJob = vi.fn(async ({ job: current }: { job: typeof job }) => {
          if (current.id !== job.id) {
            if (++startedBlockers === blockerJobs.length) {
              blockersStarted.resolve();
            }
            await releaseBlocker.promise;
            return { status: "ok" as const };
          }
          payloadStarted.resolve();
          await releasePayload.promise;
          return { status: "ok" as const };
        });
        const cron = new CronService({
          scheduler: createTestGatewayScheduler(),
          storePath,
          cronEnabled: false,
          defaultAgentId: "main",
          log: createNoopLogger(),
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob,
          onEvent: (event) => {
            if (event.action === "finished" && event.jobId === job.id) {
              finished.resolve(event);
            }
          },
        });
        const registry = createGatewayMethodRegistry(
          createCoreGatewayMethodDescriptors(cronHandlers),
        );
        const gatewayWork = new AsyncWorkScope();
        const requesterWork = new AsyncWorkScope();
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
        let tool: AnyAgentTool;
        let toolSignal: AbortSignal | undefined;
        const generations: Array<{
          signal: AbortSignal | undefined;
          cleanup: typeof cleanup;
          released: typeof generationReleased;
        }> = [];
        hoisted.createOpenClawCodingToolsMock.mockImplementation((input) => {
          const options = input as OpenClawCodingToolsOptions;
          const released = generations.length === 0 ? generationReleased : createDeferredCore();
          const generationCleanup =
            generations.length === 0
              ? cleanup
              : vi.fn(async () => {
                  released.resolve();
                });
          generations.push({ signal: options.abortSignal, cleanup: generationCleanup, released });
          options.registerRunCleanup?.(generationCleanup);
          toolSignal ??= options.abortSignal;
          // Keep the native generation/attempt owners and the actual automation
          // tool, signal wrapper, caller fence, router, handler and service real.
          tool = wrapToolWithAbortSignal(
            wrapToolWithGatewayCallerIdentity(
              createCronTool(
                { config: cfg },
                {
                  callGatewayTool: (method, _options, params) =>
                    callAgentToolGatewayRequest({ method, params }),
                },
              ),
              {
                agentId: "main",
                sessionKey: "agent:main:native-cron-admission",
                operationalRunInstance: options.operationalRunInstance,
                receiptAuthority: () => current,
                approvalSignals: options.abortSignal ? [options.abortSignal] : [],
                gatewayContextResolver: () => context,
              },
            ),
            options.abortSignal,
          );
          return [tool];
        });
        const blocker = Promise.all(blockerJobs.map((entry) => cron.run(entry.id, "force")));
        await blockersStarted.promise;
        const targetCalls = () =>
          runIsolatedAgentJob.mock.calls.filter(([input]) => input.job.id === job.id);
        try {
          const result = await requesterWork.run(() =>
            createContextEngineAttemptRunner({
              contextEngine: createContextEngineBootstrapAndAssemble(),
              sessionKey: "agent:main:native-cron-admission",
              tempPaths,
              attemptOverrides: {
                config: cfg,
                disableTools: false,
                abortSignal: controller.signal,
              },
              createSession: () =>
                Object.assign(
                  createDefaultEmbeddedSession({
                    prompt: async () => {
                      const submittedTool = tool;
                      // Worker capacity stays occupied until after this reply, so the
                      // run cannot finish within the call; return its queued ack.
                      const ack = await submittedTool.execute("queued-automation", {
                        action: "run",
                        jobId: job.id,
                        runMode: "force",
                        timeoutMs: 1,
                      });
                      expect(ack.details).toMatchObject({ ok: true, enqueued: true });
                      if (outcome === "permission change") {
                        const change = prepareEmbeddedRunPermissionChange("embedded-session");
                        expect(change.kind).toBe("active");
                        if (change.kind !== "active") {
                          throw new Error("Native permission owner missing");
                        }
                        expect(
                          await change.apply("read-only", () => {
                            expect(toolSignal?.aborted).toBe(true);
                          }),
                        ).toBe(true);
                        await expect(
                          submittedTool.execute("revoked-automation", {
                            action: "run",
                            jobId: job.id,
                            runMode: "force",
                          }),
                        ).rejects.toThrow("Aborted");
                      }
                      if (outcome === "abort before completion") {
                        controller.abort(new Error("user cancelled before the final reply"));
                        expect(toolSignal?.aborted).toBe(true);
                      }
                      // No artificial provider hold: return the final native reply now.
                    },
                  }),
                  { replaceCustomTools: vi.fn() },
                ),
            }),
          );
          expect(result.terminal.kind).toBe(
            outcome === "abort before completion" ? "aborted" : "ok",
          );
          const abortedAtCompletion = toolSignal?.aborted;
          const cleanupCallsAtCompletion = cleanup.mock.calls.length;
          const replacement = outcome === "permission change" ? generations[1] : undefined;
          if (outcome === "permission change") {
            expect(generations).toHaveLength(2);
            if (!replacement) {
              throw new Error("Permission rotation did not construct a replacement generation");
            }
            expect(replacement.signal).not.toBe(toolSignal);
            expect(replacement.signal?.aborted).toBe(false);
            expect(replacement.cleanup).not.toHaveBeenCalled();
          }
          expect(targetCalls()).toHaveLength(0);
          if (outcome === "abort") {
            controller.abort(new Error("user cancelled"));
            expect(toolSignal?.aborted).toBe(true);
          }
          if (outcome === "owner abort") {
            requesterWork.beginClose(new Error("request owner cancelled"));
            expect(toolSignal?.aborted).toBe(true);
          }
          if (outcome === "revoke") {
            current = false;
          }
          if (outcome === "stop") {
            cron.stop();
          }
          releaseBlocker.resolve();
          await blocker;
          if (outcome === "execute") {
            await Promise.race([
              payloadStarted.promise,
              finished.promise.then((event) => {
                throw new Error(
                  "Automation terminated before payload: " + event.status + " " + event.error,
                );
              }),
            ]);
            await generationReleased.promise;
            expect(cleanup).toHaveBeenCalledExactlyOnceWith("completion");
            expect(targetCalls()).toHaveLength(1);
          }
          releasePayload.resolve();
          const terminal = await finished.promise;
          await Promise.all(generations.map((generation) => generation.released.promise));
          if (replacement) {
            expect(replacement.signal?.aborted).toBe(true);
            expect(replacement.cleanup).toHaveBeenCalledExactlyOnceWith("completion");
          }
          expect(terminal.status).toBe(outcome === "execute" ? "ok" : "skipped");
          const closedBeforeCompletion =
            outcome === "abort before completion" || outcome === "permission change";
          expect(abortedAtCompletion).toBe(closedBeforeCompletion);
          expect(cleanupCallsAtCompletion).toBe(closedBeforeCompletion ? 1 : 0);
          expect(toolSignal?.aborted).toBe(true);
          expect(cleanup).toHaveBeenCalledExactlyOnceWith(
            outcome === "abort" || outcome === "owner abort" || closedBeforeCompletion
              ? "cancel"
              : "completion",
          );
          if (outcome !== "execute") {
            expect(targetCalls()).toHaveLength(0);
          }
          expect(
            (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id)?.state
              .queuedAtMs,
          ).toBeUndefined();
        } finally {
          releaseBlocker.resolve();
          releasePayload.resolve();
          await blocker;
          cron.stop();
          await cron.waitForIdle();
          await gatewayWork.runWhenIdle(() => undefined);
          await requesterWork.runWhenIdle(() => undefined);
          await gatewayWork.drain();
          await requesterWork.drain();
          expect(getTotalQueueSize()).toBe(0);
          resetCommandQueueStateForTest();
        }
      });
    },
  );
});

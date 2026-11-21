import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
import * as gatewayModule from "../../agents/tools/gateway.js";
import { callAgentToolGatewayRequest } from "../../agents/tools/in-process-gateway.js";
import { getTotalQueueSize } from "../../process/command-queue.js";
import {
  getSessionControllerEntryForOperation,
  getSessionControllerOperation,
} from "../../sessions/session-controller.state.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { occupyWorkers, readJob, withCronGatewayState } from "./ops.gateway.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];
const sessionKey = "agent:main:native-cron-admission";

function toolGeneration(signal?: AbortSignal) {
  const released = createDeferredCore();
  return { signal, released, cleanup: vi.fn(async () => released.resolve()) };
}

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
    "keeps accepted automation independent of its tool generation's lifetime: %s",
    async (outcome) => {
      await withCronGatewayState(async (fixture) => {
        const { cfg, context, cron, finished } = fixture;
        const gatewaySpy = vi
          .spyOn(gatewayModule, "callGatewayTool")
          .mockImplementation((method, _options, params) =>
            callAgentToolGatewayRequest({ method, params }),
          );
        onTestFinished(() => gatewaySpy.mockRestore());
        const now = Date.now();
        const job = createDueIsolatedJob({ id: "native-queued-run", nowMs: now, nextRunAtMs: now });
        const payloadStarted = createDeferredCore();
        const releasePayload = createDeferredCore();
        const requesterWork = new AsyncWorkScope();
        const controller = new AbortController();
        let current = true;
        let tool: AnyAgentTool;
        let toolSignal: AbortSignal | undefined;
        const generations: ReturnType<typeof toolGeneration>[] = [];
        hoisted.createOpenClawCodingToolsMock.mockImplementation((input) => {
          const options = input as OpenClawCodingToolsOptions;
          const generation = toolGeneration(options.abortSignal);
          generations.push(generation);
          options.registerRunCleanup?.(generation.cleanup);
          toolSignal ??= options.abortSignal;
          tool = wrapToolWithAbortSignal(
            wrapToolWithGatewayCallerIdentity(createCronTool({ config: cfg }), {
              agentId: "main",
              sessionKey,
              operationalRunInstance: options.operationalRunInstance,
              receiptAuthority: () => current,
              approvalSignals: options.abortSignal ? [options.abortSignal] : [],
              gatewayContextResolver: () => context,
            }),
            options.abortSignal,
          );
          return [tool];
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
          const result = await requesterWork.run(() =>
            createContextEngineAttemptRunner({
              contextEngine: createContextEngineBootstrapAndAssemble(),
              sessionKey,
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
                      const runArgs = { action: "run", jobId: job.id, runMode: "force" } as const;
                      const ack = await submittedTool.execute("queued-automation", {
                        ...runArgs,
                        timeoutMs: 1,
                      });
                      expect(ack.details).toMatchObject({ ok: true, enqueued: true });
                      if (outcome === "permission change") {
                        const operation = getSessionControllerOperation(sessionKey);
                        const target =
                          operation && getSessionControllerEntryForOperation(operation).target;
                        if (!target) {
                          throw new Error("Native permission target missing");
                        }
                        const change = prepareEmbeddedRunPermissionChange(target);
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
                          submittedTool.execute("revoked-automation", runArgs),
                        ).rejects.toThrow("Aborted");
                      }
                      if (outcome === "abort before completion") {
                        controller.abort(new Error("user cancelled before the final reply"));
                        expect(toolSignal?.aborted).toBe(true);
                      }
                    },
                  }),
                  { replaceCustomTools: vi.fn() },
                ),
            }),
          );
          expect(result.terminal.kind).toBe(
            outcome === "abort before completion" ? "aborted" : "ok",
          );
          const firstGeneration = generations[0];
          if (!firstGeneration) {
            throw new Error("Native attempt did not construct a tool generation");
          }
          const { cleanup, released: generationReleased } = firstGeneration;
          const abortedAtCompletion = toolSignal?.aborted;
          const cleanupCallsAtCompletion = cleanup.mock.calls.length;
          const closedBeforeCompletion =
            outcome === "abort before completion" || outcome === "permission change";
          const cleanupReason =
            outcome === "abort" || outcome === "owner abort" || closedBeforeCompletion
              ? "cancel"
              : "completion";
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
          if (outcome !== "stop") {
            await Promise.race([
              payloadStarted.promise,
              finished(job.id).then((event) => {
                throw new Error(
                  "Automation terminated before payload: " + event.status + " " + event.error,
                );
              }),
            ]);
            await generationReleased.promise;
            expect(cleanup).toHaveBeenCalledExactlyOnceWith(cleanupReason);
            expect(targetCalls()).toHaveLength(1);
          }
          releasePayload.resolve();
          const terminal = await finished(job.id);
          await Promise.all(generations.map((generation) => generation.released.promise));
          if (replacement) {
            expect(replacement.signal?.aborted).toBe(true);
            expect(replacement.cleanup).toHaveBeenCalledExactlyOnceWith("completion");
          }
          expect(terminal.status).toBe(outcome === "stop" ? "skipped" : "ok");
          expect(abortedAtCompletion).toBe(closedBeforeCompletion);
          expect(cleanupCallsAtCompletion).toBe(closedBeforeCompletion ? 1 : 0);
          expect(toolSignal?.aborted).toBe(true);
          expect(cleanup).toHaveBeenCalledExactlyOnceWith(cleanupReason);
          expect(targetCalls()).toHaveLength(outcome === "stop" ? 0 : 1);
          expect((await readJob(fixture, job.id))?.state.queuedAtMs).toBeUndefined();
        } finally {
          releaseBlocker.resolve();
          releasePayload.resolve();
          await blocker;
          cron.stop();
          await cron.waitForIdle();
          await fixture.settle();
          await requesterWork.runWhenIdle(() => undefined);
          await requesterWork.drain();
          expect(getTotalQueueSize()).toBe(0);
        }
      });
    },
  );
});

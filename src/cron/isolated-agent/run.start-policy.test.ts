import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { clearCronJobActive, markCronJobActive } from "../active-jobs.js";
import { isCronExecutionIdle } from "../execution-idle.js";
import { waitForCronExecutionIdle } from "../service/execution-idle.js";
import { createCronServiceState, type CronIdleAdmissionWait } from "../service/state.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as h from "./run.test-harness.js";

const runAgent = await h.loadRunCronIsolatedAgentTurn();
const withinWindow = Date.parse("2026-10-20T09:30:00.000Z");
const afterWindow = Date.parse("2026-10-20T10:00:00.000Z");
const activeHours = { start: "09:00", end: "10:00", timezone: "UTC" };

function controlClock() {
  const clock = vi.spyOn(Date, "now").mockReturnValue(withinWindow);
  onTestFinished(() => clock.mockRestore());
  return clock;
}

function makeParams(overrides: Record<string, unknown> = {}) {
  return makeIsolatedAgentParamsFixture({
    job: makeIsolatedAgentJobFixture({
      activeHours,
      idleOnly: true,
      delivery: { mode: "none" },
    }),
    ...overrides,
  });
}

describe("isolated automation actual-start policy", () => {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => h.mockRunCronFallbackPassthrough());

  it.each(["embedded", "cli"] as const)(
    "defers a prepared %s run when its window closes before the provider effect",
    async (backend) => {
      const clock = controlClock();
      const providerEffect = vi.fn();
      const onExecutionStarted = vi.fn();
      h.isCliProviderMock.mockReturnValue(backend === "cli");
      const runner = backend === "cli" ? h.runCliAgentMock : h.runEmbeddedAgentMock;
      runner.mockImplementationOnce(async (runParams) => {
        clock.mockReturnValue(afterWindow);
        await runParams.onExecutionStarted?.();
        providerEffect();
        return {
          payloads: [{ text: "Should not run outside the window" }],
          meta: { agentMeta: {} },
        };
      });

      const result = await runAgent(makeParams({ onExecutionStarted }));

      expect(runner).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        status: "skipped",
        executionStarted: false,
        admissionDeferred: true,
        admissionDeferredReason: "active-hours",
      });
      expect(providerEffect).not.toHaveBeenCalled();
      expect(onExecutionStarted).not.toHaveBeenCalled();
      expect(h.dispatchCronDeliveryMock).not.toHaveBeenCalled();
    },
  );

  it.for(["ready", "window-closed", "authority-revoked"] as const)(
    "rechecks actual-start policy after foreground work settles (%s)",
    async (afterWait, { signal }) => {
      const clock = controlClock();
      const waiting = createDeferred();
      const providerEffect = vi.fn();
      const onExecutionStarted = vi.fn();
      const cancellation = new AbortController();
      const activeSignal = AbortSignal.any([signal, cancellation.signal]);
      let authorityCurrent = true;
      const assertCurrent = () => {
        if (!authorityCurrent) {
          throw new Error("Scheduled source authority revoked");
        }
      };
      const params: Parameters<typeof runAgent>[0] = makeParams({
        abortSignal: activeSignal,
        assertCurrent,
        onExecutionStarted,
      });
      const activeJobMarker = markCronJobActive(params.job.id, { agentId: "default" });
      const state = createCronServiceState({
        scheduler: createTestGatewayScheduler(),
        storePath: "/tmp/store.json",
        cronEnabled: true,
        defaultAgentId: "default",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        enqueueSystemEvent: vi.fn(),
        runIsolatedAgentJob: vi.fn(),
        isExecutionIdle: (job, ownSessionKey, ownReplyOperation) => {
          const idle = isCronExecutionIdle(
            params.cfg,
            job,
            "default",
            ownSessionKey,
            ownReplyOperation,
          );
          if (!idle) {
            waiting.resolve();
          }
          return idle;
        },
      });
      const waitForIdle: CronIdleAdmissionWait = (ownSessionKey, abortSignal, ownReplyOperation) =>
        waitForCronExecutionIdle(state, params.job, {
          activeJobMarker,
          ownSessionKey,
          ownReplyOperation,
          signal: abortSignal ?? activeSignal,
          assertCurrent,
        });
      let foreground: ReplyOperation | undefined;
      h.runEmbeddedAgentMock.mockImplementationOnce(async (runParams) => {
        foreground = createReplyOperation({
          sessionKey: "agent:default:foreground",
          sessionId: "foreground",
          resetTriggered: false,
          turnKind: "visible",
        });
        await runParams.onExecutionStarted?.();
        providerEffect();
        return { payloads: [{ text: "Foreground work has settled" }], meta: { agentMeta: {} } };
      });
      const pending = runAgent({ ...params, waitForIdle });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            waiting.promise,
            pending,
            "Automation bypassed foreground idle admission",
          ),
          signal,
        );
        expect(providerEffect).not.toHaveBeenCalled();
        expect(onExecutionStarted).not.toHaveBeenCalled();
        if (afterWait === "window-closed") {
          clock.mockReturnValue(afterWindow);
        } else if (afterWait === "authority-revoked") {
          authorityCurrent = false;
        }
        foreground?.complete();
        const result = await withinTest(pending, signal);
        if (afterWait === "ready") {
          expect(result.status, result.error).toBe("ok");
          expect(providerEffect).toHaveBeenCalledOnce();
          expect(onExecutionStarted).toHaveBeenCalledOnce();
        } else {
          expect(result).toMatchObject(
            afterWait === "window-closed"
              ? {
                  status: "skipped",
                  executionStarted: false,
                  admissionDeferred: true,
                  admissionDeferredReason: "active-hours",
                }
              : {
                  status: "error",
                  executionStarted: false,
                  error: "Scheduled source authority revoked",
                },
          );
          expect(providerEffect).not.toHaveBeenCalled();
          expect(onExecutionStarted).not.toHaveBeenCalled();
          expect(h.dispatchCronDeliveryMock).not.toHaveBeenCalled();
        }
      } finally {
        cancellation.abort();
        foreground?.complete();
        await Promise.allSettled([pending]);
        clearCronJobActive(params.job.id, activeJobMarker);
        await state.schedulerScope.stop();
      }
    },
  );
});

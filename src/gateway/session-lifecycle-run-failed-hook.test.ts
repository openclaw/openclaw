import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  event,
  reports,
  runId,
  seed,
  target,
} from "./session-lifecycle-run-failure.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

afterEach(() => clearRuntimeConfigSnapshot());

describe("committed run-failure hook", () => {
  it("dispatches one safe committed failure without awaiting the reporting plugin", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      await seed();
      const observed = createDeferred<{ notice: unknown; context: unknown; stored: unknown[] }>();
      const release = createDeferred();
      const finished = createDeferred();
      const handler = vi.fn(async (notice, context) => {
        try {
          observed.resolve({ notice, context, stored: await reports() });
          await release.promise;
          throw new Error("Synthetic report delivery failed");
        } catch (error) {
          observed.reject(error);
          throw error;
        } finally {
          finished.resolve();
        }
      });
      initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "run_failed", handler }]));
      onTestFinished(async () => {
        release.resolve();
        resetGlobalHookRunner();
        if (handler.mock.calls.length > 0) {
          await finished.promise;
        }
      });
      await persistGatewaySessionLifecycleEvent({
        ...target,
        event: {
          ...event,
          data: {
            ...event.data,
            error: "PRIVATE_PROVIDER_ERROR_SENTINEL",
            errorObservation: {
              provider: "test-provider",
              failoverReason: "unavailable",
              rawError: "PRIVATE_PROVIDER_ERROR_SENTINEL",
            },
          },
        },
      });
      const observation = await observed.promise;
      expect(observation.stored).toHaveLength(1);
      expect(observation.notice).toEqual({
        runId,
        summary: "Your request couldn't be completed.",
        cause: { provider: "test-provider", failoverReason: "unavailable" },
      });
      expect(observation.context).toEqual(target);
      // The first callback is still pending; neither settlement nor a duplicate waits for it.
      await persistGatewaySessionLifecycleEvent({ ...target, event });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(loadSessionEntry(target)?.status).toBe("failed");
      release.resolve();
      await finished.promise;
      expect(await reports()).toHaveLength(1);
    });
  });

  it.each([
    { data: { phase: "start" } },
    { data: { phase: "end" } },
    { data: { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" } },
    { data: { phase: "error", aborted: true, stopReason: "aborted" } },
    { data: { phase: "aborted" } },
    { data: { ...event.data, startedAt: 500 }, runId: "stale-run" },
    { data: event.data, sessionId: "stale-session" },
  ])("does not notify non-failures or stale work: %j", async (changes) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      await seed();
      const handler = vi.fn();
      initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "run_failed", handler }]));
      onTestFinished(resetGlobalHookRunner);
      await persistGatewaySessionLifecycleEvent({ ...target, event: { ...event, ...changes } });
      expect(await reports()).toEqual([]);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});

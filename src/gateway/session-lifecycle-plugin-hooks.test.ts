import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import * as admission from "../process/gateway-work-admission.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  forgetActiveSessionForShutdown,
  listActiveSessionsForShutdown,
} from "./active-sessions-shutdown-tracker.js";
import {
  emitGatewaySessionEndPluginHook,
  emitGatewaySessionStartPluginHook,
} from "./session-lifecycle-plugin-hooks.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  for (const entry of listActiveSessionsForShutdown()) {
    forgetActiveSessionForShutdown(entry.sessionId);
  }
  resetGlobalHookRunner();
  admission.resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

describe("session lifecycle plugin hook lifetime", () => {
  it.for([
    { hookName: "session_end", parentPresent: true, fails: false },
    { hookName: "session_start", parentPresent: true, fails: false },
    { hookName: "session_end", parentPresent: false, fails: false },
    { hookName: "session_end", parentPresent: true, fails: true },
  ] as const)(
    "$hookName tracks deferred work (parent=$parentPresent, failure=$fails)",
    async ({ hookName, parentPresent, fails }, { signal }) => {
      const parent = parentPresent ? new AsyncWorkScope() : undefined;
      const root = parentPresent
        ? admission.tryBeginGatewayRootWorkAdmission("test:session-hook")
        : undefined;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const effect = vi.fn();
      const handler = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        await trackAsyncWork(() => {
          effect();
          if (fails) {
            throw new Error("synthetic session cleanup failure");
          }
        });
      });
      initializeGlobalHookRunner(createMockPluginRegistry([{ hookName, handler }]));
      // Observe completion without replacing either lifetime owner or polling its count.
      const continuations = [
        vi.spyOn(admission, "runWithGatewayIndependentRootWorkContinuation"),
        vi.spyOn(admission, "runWithGatewayDetachedWorkContinuation"),
      ];
      const joinContinuations = () =>
        Promise.allSettled(
          continuations.flatMap((spy) =>
            spy.mock.results
              .filter((result) => result.type === "return")
              .map((result) => result.value),
          ),
        );
      const params = {
        cfg: {},
        sessionKey: "agent:main:main",
        sessionId: "session-hook-test",
        storePath: path.join(tempDirs.make("session-hook-lifetime-"), "sessions.json"),
        agentId: "main",
        reason: "reset" as const,
      };
      const emit = () =>
        hookName === "session_end"
          ? emitGatewaySessionEndPluginHook(params)
          : emitGatewaySessionStartPluginHook(params);
      try {
        if (parent) {
          if (!root) {
            throw new Error("Expected parent root admission");
          }
          await root.run(async () => parent.run(emit));
        } else {
          emit();
        }
        await withinTest(entered.promise, signal);
        root?.release();
        // External work stays held until the triggering requester has fully closed.
        await parent?.drain();
        expect(effect).not.toHaveBeenCalled();
        expect(admission.getActiveGatewayRootWorkCount()).toBe(1);
        release.resolve();
        await withinTest(joinContinuations(), signal);
        expect(effect).toHaveBeenCalledExactlyOnceWith();
        expect(admission.getActiveGatewayRootWorkCount()).toBe(0);
        const completion = handler.mock.results[0]?.value;
        if (fails) {
          await expect(completion).rejects.toThrow("synthetic session cleanup failure");
        } else {
          await expect(completion).resolves.toBeUndefined();
        }
      } finally {
        release.resolve();
        root?.release();
        await parent?.drain();
        await joinContinuations();
      }
    },
  );
});

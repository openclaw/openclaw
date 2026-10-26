import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import * as admission from "../process/gateway-work-admission.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { forgetActiveSessionForShutdown } from "./active-sessions-shutdown-tracker.js";
import {
  emitGatewaySessionEndPluginHook,
  emitGatewaySessionStartPluginHook,
} from "./session-lifecycle-plugin-hooks.js";

afterEach(() => {
  forgetActiveSessionForShutdown("session-hook-test");
  resetGlobalHookRunner();
  admission.resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

it.for([
  { hookName: "session_end", fails: false },
  { hookName: "session_start", fails: false },
  { hookName: "session_end", fails: true },
] as const)(
  "$hookName tracks deferred work after the parent closes (failure=$fails)",
  async ({ hookName, fails }, { signal }) => {
    const parent = new AsyncWorkScope();
    const root = expectDefined(
      admission.tryBeginGatewayRootWorkAdmission("test:session-hook"),
      "root",
    );
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const effect = vi.fn();
    const handler = async () => {
      entered.resolve();
      await release.promise;
      await trackAsyncWork(() => {
        effect();
        if (fails) {
          throw new Error("synthetic session cleanup failure");
        }
      });
    };
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName, handler }]));
    // Observe completion without replacing either lifetime owner or polling its count.
    const continuation = vi.spyOn(admission, "runWithGatewayDetachedWorkContinuation");
    const joinContinuations = () =>
      Promise.allSettled(continuation.mock.results.map((result) => result.value));
    const params = {
      cfg: {},
      sessionKey: "agent:main:main",
      sessionId: "session-hook-test",
      storePath: "/synthetic/session-hook-lifetime/sessions.json",
      agentId: "main",
      reason: "reset" as const,
    };
    const emit = () =>
      hookName === "session_end"
        ? emitGatewaySessionEndPluginHook(params)
        : emitGatewaySessionStartPluginHook(params);
    try {
      await root.run(async () => parent.run(emit));
      await withinTest(entered.promise, signal);
      root.release();
      // External work stays held until the triggering requester has fully closed.
      await parent.drain();
      expect(effect).not.toHaveBeenCalled();
      expect(admission.getActiveGatewayRootWorkCount()).toBe(1);
      release.resolve();
      await withinTest(joinContinuations(), signal);
      expect(effect).toHaveBeenCalledExactlyOnceWith();
      expect(admission.getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      release.resolve();
      root.release();
      await parent.drain();
      await joinContinuations();
    }
  },
);

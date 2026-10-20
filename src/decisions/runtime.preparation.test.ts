import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as profileReader from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { decisionBatchV1ToV2 } from "./compatibility.js";
import { answer, batch, config, options, registered } from "./runtime.test-support.js";
import type { DecisionProviderV1 } from "./types.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

it.each(
  ([1, 2] as const).flatMap((version) =>
    (["expired", "partial", "caller-aborted", "authority-closed"] as const).map((ending) => ({
      version,
      ending,
    })),
  ),
)(
  "preserves the Decision V$version caller budget through $ending preparation",
  async ({ version, ending }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot(config);
      const context = createContext();
      context.getRuntimeConfig = () => config;
      const client = createOperatorClient({
        profileName: "decision-preparation",
        scopes: ["operator.write"],
      });
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const originalPrepare = profileReader.prepareUserProfileIdentity;
      const preparation = vi
        .spyOn(profileReader, "prepareUserProfileIdentity")
        .mockImplementationOnce(async (...args) => {
          const prepared = await originalPrepare(...args);
          entered.resolve();
          await resume.promise;
          return prepared;
        });
      const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async (_batch, { signal }) => {
        if (ending === "partial") {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return answer;
      });
      const host = registered(evaluate);
      const controller = new AbortController();
      let current = true;
      let now = 1_000;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      const pending = withPluginRuntimeGatewayRequestScope(
        {
          client,
          context,
          hasCurrentClientAuthority: () => current,
          isWebchatConnect: () => false,
        },
        () => {
          const requestOptions = {
            ...options(),
            timeoutMs: 500,
            signal: controller.signal,
          };
          return version === 1
            ? host.api.runtime.decisions.evaluate(batch, requestOptions)
            : host.api.runtime.decisions.evaluateV2(decisionBatchV1ToV2(batch)!, requestOptions);
        },
      );
      const settled = pending.then(
        (outcome) => ({ outcome }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([entered.promise, settled]);
        expect(preparation).toHaveBeenCalledOnce();
        expect(evaluate).not.toHaveBeenCalled();
        now += ending === "partial" ? 200 : 500;
        const cancellation = new Error("Decision caller cancelled");
        if (ending === "caller-aborted") {
          controller.abort(cancellation);
        } else if (ending === "authority-closed") {
          current = false;
        }
        // Start fake timers after real profile I/O; only provider timing is simulated.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        resume.resolve();
        if (ending === "partial") {
          await Promise.race([host.started, settled]);
          expect(evaluate).toHaveBeenCalledOnce();
          await vi.advanceTimersByTimeAsync(299);
          expect(evaluate.mock.calls[0]?.[1].signal.aborted).toBe(false);
          now += 300;
          await vi.advanceTimersByTimeAsync(1);
          expect(evaluate.mock.calls[0]?.[1].signal.aborted).toBe(true);
        }
        if (ending === "caller-aborted") {
          expect(await settled).toEqual({ error: cancellation });
        } else if (ending === "authority-closed") {
          expect(await settled).toEqual({
            error: expect.objectContaining({
              message: "Gateway caller authority is no longer active.",
            }),
          });
        } else {
          expect(await settled).toEqual({
            outcome: { status: "unavailable", reason: "deadline" },
          });
        }
        expect(evaluate).toHaveBeenCalledTimes(ending === "partial" ? 1 : 0);
        expect(host.registry.decisionProviders[0]!.host.inspect(config).activeRequests).toBe(0);
      } finally {
        resume.resolve();
        controller.abort();
        await settled;
        vi.useRealTimers();
        clock.mockRestore();
        preparation.mockRestore();
      }
    });
  },
);

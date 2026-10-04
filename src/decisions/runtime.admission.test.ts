import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { captureGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { evaluateDecisionInRegistry } from "./runtime.js";
import { answer, batch, config, options, registered } from "./runtime.test-support.js";
import type { DecisionProviderV1 } from "./types.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

describe("registered decision consumer admission", () => {
  it.each(["consumer", "runtime"] as const)(
    "composes %s admission with the guarded request boundary",
    async (withdraw) => {
      let consumerAllowed = true;
      let runtimeAllowed = true;
      const host = registered(async (_batch, context) => {
        expect(context.isAdmissible?.()).toBe(true);
        consumerAllowed = withdraw !== "consumer";
        runtimeAllowed = withdraw !== "runtime";
        expect(() => captureGuardedFetchRequestAuthority()?.()).toThrow(
          "Decision dispatch is no longer admitted",
        );
        consumerAllowed = true;
        runtimeAllowed = true;
        expect(context.isAdmissible?.()).toBe(false);
        return { status: "unavailable", reason: "transport" };
      });
      expect(
        await evaluateDecisionInRegistry(
          batch,
          { ...options(), admit: () => consumerAllowed },
          host.registry,
          config,
          undefined,
          () => runtimeAllowed,
        ),
      ).toEqual({ status: "unavailable", reason: "disabled" });
      expect(host.registry.decisionProviders[0]?.host.inspect(config)).toMatchObject({
        activeRequests: 0,
        callable: true,
      });
    },
  );

  it("keeps revoked admission closed across provider cleanup without poisoning health", async () => {
    let current = true;
    const call = vi.fn<DecisionProviderV1["evaluate"]>(async (_batch, context) => {
      current = false;
      expect(context.isAdmissible?.()).toBe(false);
      current = true;
      // A transport may sanitize its guard failure and await cleanup before returning.
      await Promise.resolve();
      expect(context.isAdmissible?.()).toBe(false);
      return { status: "unavailable", reason: "transport" };
    });
    const host = registered(call);
    for (let i = 0; i < 3; i++) {
      expect(
        await evaluateDecisionInRegistry(
          batch,
          options(),
          host.registry,
          config,
          undefined,
          () => current,
        ),
      ).toEqual({ status: "unavailable", reason: "disabled" });
    }
    expect(host.registry.decisionProviders[0]?.host.inspect(config)).toMatchObject({
      activeRequests: 0,
      successCount: 0,
      callable: true,
      reasons: { disabled: 3 },
    });
    call.mockResolvedValueOnce(answer);
    expect(await host.run()).toMatchObject({ status: "ok" });
    expect(call).toHaveBeenCalledTimes(4);
  });

  it.each(["authority", "cancel"] as const)(
    "preserves %s rejection through provider error sanitization",
    async (kind) => {
      const failure = new Error("consumer authority closed");
      const cancelled = new Error("caller cancelled");
      const controller = new AbortController();
      let throwing = false;
      let current = true;
      const host = registered(async (_batch, context) => {
        throwing = true;
        expect(() => context.isAdmissible?.()).toThrow(failure);
        throwing = false;
        current = false;
        if (kind === "cancel") {
          controller.abort(cancelled);
        }
        await Promise.resolve();
        return { status: "unavailable", reason: "transport" };
      });
      const pending = evaluateDecisionInRegistry(
        batch,
        { ...options(), signal: controller.signal },
        host.registry,
        config,
        undefined,
        () => {
          if (throwing) {
            throw failure;
          }
          return current;
        },
      );
      await expect(pending).rejects.toBe(kind === "cancel" ? cancelled : failure);
      expect(host.registry.decisionProviders[0]?.host.inspect(config)).toMatchObject({
        activeRequests: 0,
        successCount: 0,
        callable: true,
      });
    },
  );
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecisionTool } from "../agents/tools/decision-tool.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { unavailable } from "./contract.test-support.js";
import { evaluateDecisionInRegistry } from "./runtime.js";
import { answer, batch, config, options, registered } from "./runtime.test-support.js";
import type { DecisionProviderV1 } from "./types.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

describe("registered decision consumer admission", () => {
  it.each(["unchanged", "secrets-cleared", "selection-changed"] as const)(
    "checks host authority before an explicit V1 tool dispatch (%s)",
    async (change) => {
      setRuntimeConfigSnapshot(config);
      const release = createDeferredCore();
      const dispatch = vi.fn(async () => answer);
      const host = registered(async (_batch, context) => {
        await release.promise;
        if (context.isAdmissible?.() === false) {
          return unavailable("transport");
        }
        return dispatch();
      });
      const tool = createDecisionTool("main", { config });
      expect(tool).not.toBeNull();
      const pending = tool!.execute("admission", {
        contractVersion: 2,
        state: { type: "text", text: "synthetic" },
        questions: batch.questions,
      });
      try {
        await Promise.race([host.started, pending]);
        expect(dispatch).not.toHaveBeenCalled();
        if (change === "secrets-cleared") {
          clearSecretsRuntimeSnapshot();
          // Keep selection identical so only the secret generation closes admission.
          setRuntimeConfigSnapshot(config);
        } else if (change === "selection-changed") {
          setRuntimeConfigSnapshot({
            agents: { defaults: { decisionModel: "fixture/replacement-v1" } },
          });
        }
        release.resolve();
        await expect(pending).resolves.toMatchObject({
          details: change === "unchanged" ? { status: "ok" } : unavailable("retiring"),
        });
        expect(dispatch).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
        expect(host.registry.decisionProviders[0]!.host.inspect(config).activeRequests).toBe(0);
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
      }
    },
  );

  it("rejects an invalid priority before provider dispatch", async () => {
    const call = vi.fn(async () => answer);
    const host = registered(call);
    const requestOptions = options();
    Reflect.set(requestOptions, "priority", "urgent");
    await expect(host.run(requestOptions)).rejects.toThrow("Invalid decision contract");
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps revoked admission closed across provider cleanup without poisoning health", async () => {
    let current = true;
    const call = vi.fn<DecisionProviderV1["evaluate"]>(async (_batch, context) => {
      current = false;
      expect(context.isAdmissible?.()).toBe(false);
      current = true;
      // A transport may sanitize its guard failure and await cleanup before returning.
      await Promise.resolve();
      expect(context.isAdmissible?.()).toBe(false);
      return unavailable("transport");
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
      ).toEqual(unavailable("disabled"));
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
        return unavailable("transport");
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

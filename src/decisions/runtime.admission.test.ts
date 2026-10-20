import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateAttemptDecisionToolPrefilter } from "../agents/embedded-agent-runner/run/attempt-decision-prefilter.js";
import { createDecisionTool } from "../agents/tools/decision-tool.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
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
          return { status: "unavailable", reason: "transport" };
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
          details:
            change === "unchanged"
              ? { status: "ok" }
              : { status: "unavailable", reason: "retiring" },
        });
        expect(dispatch).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
        expect(host.registry.decisionProviders[0]!.host.inspect(config).activeRequests).toBe(0);
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
      }
    },
  );

  it("reserves the fourth physical slot for requested work until optional callbacks settle", async () => {
    const selected = {
      agents: {
        defaults: {
          decisionModel: "fixture/fixture-v1",
          experimental: { decisionAssistance: true },
        },
      },
    };
    setRuntimeConfigSnapshot(selected);
    const started = Array.from({ length: 3 }, () => createDeferredCore());
    const release = Array.from({ length: 3 }, () => createDeferredCore());
    const cancelled = new AbortController();
    let calls = 0;
    const host = registered(async () => {
      const index = calls++;
      if (index < release.length) {
        started[index]!.resolve();
        // An abort-ignoring provider retains its physical slot until cleanup settles.
        await release[index]!.promise;
      }
      return answer;
    });
    const providerHost = host.registry.decisionProviders[0]!.host;
    const pending: ReturnType<typeof host.run>[] = [];
    const prefilter = () =>
      evaluateAttemptDecisionToolPrefilter({
        config: selected,
        agentId: "main",
        supportsTurnScopedToolRestrictions: true,
        assertActive: () => {},
        userMessage: "Hello",
        signal: new AbortController().signal,
      });
    try {
      for (const [index, priority] of (["optional", "requested", "optional"] as const).entries()) {
        const request = host.run(
          { ...options(), priority, ...(index === 0 ? { signal: cancelled.signal } : {}) },
          selected,
        );
        pending.push(request);
        await Promise.race([started[index]!.promise, request]);
        expect(calls).toBe(index + 1);
      }
      expect(await prefilter()).toMatchObject({
        shouldPruneTools: false,
        status: "unavailable",
      });
      expect(calls).toBe(3);
      // Purpose is diagnostic text, not the source of admission priority.
      await expect(
        host.run({ ...options(), purpose: "tool-prefilter.semantic-gate" }, selected),
      ).resolves.toMatchObject({ status: "ok" });
      expect(calls).toBe(4);

      const reason = new Error("optional consumer cancelled");
      const rejected = expect(pending[0]!).rejects.toBe(reason);
      cancelled.abort(reason);
      expect(providerHost.inspect(selected).activeRequests).toBe(3);
      expect(await prefilter()).toMatchObject({ status: "unavailable", shouldPruneTools: false });
      expect(calls).toBe(4);
      release[0]!.resolve();
      await rejected;
      await expect(
        host.run({ ...options(), priority: "optional" }, selected),
      ).resolves.toMatchObject({ status: "ok" });
      expect(calls).toBe(5);
    } finally {
      for (const callback of release) {
        callback.resolve();
      }
      await Promise.allSettled(pending);
    }
    expect(providerHost.inspect(selected).activeRequests).toBe(0);
  });

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

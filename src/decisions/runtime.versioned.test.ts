import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { decisionBatchV1ToV2 } from "./compatibility.js";
import { createHostDecisionEvaluator } from "./runtime.js";
import { batch, answer, config, options, registered } from "./runtime.test-support.js";
import type { DecisionProviderV1 } from "./types.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});
describe("versioned registered decision execution", () => {
  it("joins physical provider settlement without making its result await host disposal", async () => {
    vi.useFakeTimers();
    const started = createDeferredCore();
    const finish = createDeferredCore();
    const host = registered(async () => {
      started.resolve();
      await finish.promise;
      return answer;
    });
    const pending = host.run();
    await started.promise;
    const disposal = getPluginInstance(host.record)!.dispose();
    let settled = false;
    void pending
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    finish.resolve();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await expect(pending).resolves.toMatchObject({ status: "unavailable", reason: "retiring" });
      expect((await disposal).errors).toEqual([]);
    } finally {
      await vi.runAllTimersAsync();
      await pending.catch(() => {});
      await disposal;
      vi.useRealTimers();
    }
  });

  it.each([1, 2] as const)(
    "finalizes registered V%s decision usage once without inventing USD",
    async (version) => {
      const host = registered();
      setRuntimeConfigSnapshot(config);
      const events: DiagnosticEventPayload[] = [];
      const stop = onTrustedInternalDiagnosticEvent(
        markTrustedOtelDiagnosticListener((event) => {
          if (event.type === "model.usage") {
            events.push(event);
          }
        }),
      );
      onTestFinished(stop);
      const result =
        version === 1
          ? await host.api.runtime.decisions.evaluate(batch, options())
          : await host.api.runtime.decisions.evaluateV2(decisionBatchV1ToV2(batch)!, options());
      expect(result.status).toBe("ok");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        provider: "fixture",
        model: "fixture-v1",
        usage: { input: 25, output: 4 },
      });
      expect(events[0]).not.toHaveProperty("costUsd");
    },
  );

  it("runs richer decisions through the registered decision SDK without ambient evidence", async () => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    const host = registered(evaluate);
    setRuntimeConfigSnapshot(config);
    const result = await host.api.runtime.decisions.evaluateV2(
      decisionBatchV1ToV2(batch)!,
      options(),
    );
    expect(result).toMatchObject(answer);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[0]).toEqual(batch);
    await getPluginInstance(host.record)?.dispose();
    await expect(
      host.api.runtime.decisions.evaluateV2(decisionBatchV1ToV2(batch)!, options()),
    ).rejects.toThrow("runtime is no longer active");
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("rejects unsupported decision controls without dispatch or implicit grounding", async () => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    const host = registered(evaluate);
    setRuntimeConfigSnapshot(config);
    for (const extra of [
      { grounding: {} },
      { model: "fixture/other" },
      { authProfileId: "unowned" },
    ]) {
      await expect(
        host.api.runtime.decisions.evaluateV2(decisionBatchV1ToV2(batch)!, {
          ...options(),
          ...extra,
        }),
      ).rejects.toThrow("Invalid decision contract");
    }
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("keeps host-issued decision agent binding authoritative without an override grant", async () => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    registered(evaluate);
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { decisionModel: "fixture/global" },
        entries: { worker: { decisionModel: "fixture/worker" } },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const bound = createHostDecisionEvaluator({
      getConfig: () => cfg,
      authority: {
        agentId: "worker",
        requiresBoundAgent: true,
        caller: { kind: "plugin", id: "owner" },
        pluginIdForPolicy: "owner",
      },
    });
    expect((await bound(decisionBatchV1ToV2(batch)!, options())).status).toBe("ok");
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({ agentId: "worker", model: "worker" });
    await expect(
      bound(decisionBatchV1ToV2(batch)!, { ...options(), agentId: "other" }),
    ).rejects.toThrow("cannot override the active session agent");
    const denied = createHostDecisionEvaluator({
      getConfig: () => cfg,
      authority: { agentId: "worker", allowComplete: false },
    });
    await expect(denied(decisionBatchV1ToV2(batch)!, options())).rejects.toThrow("denied");
    expect(evaluate).toHaveBeenCalledOnce();
  });
});

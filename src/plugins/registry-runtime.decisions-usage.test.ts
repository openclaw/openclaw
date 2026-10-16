import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareDecisionProviderReload } from "../decisions/runtime.js";
import type {
  DecisionBatchV2,
  DecisionProviderV2,
  ProviderDecisionOutcomeV2,
} from "../decisions/types-v2.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import type { PreparedDecisionBillingFacts } from "./runtime/runtime-model-usage.js";
import type { PluginRuntime } from "./runtime/types.js";

const preparation = vi.hoisted(() => ({
  billing: undefined as PreparedDecisionBillingFacts["billing"],
}));

// The registered provider host, validation, lifecycle fences, SDK wrapper and accounting stay real.
// mock-isolation: Keep auth/catalog preparation isolated from this usage accounting fixture.
vi.mock("../agents/decision-inference.js", () => ({
  executePreparedDecision: (
    params: Parameters<typeof import("../agents/decision-inference.js").executePreparedDecision>[0],
  ) => {
    params.onPreparedBilling?.({
      provider: "fixture",
      model: "native",
      billing: preparation.billing,
    });
    return params.provider.evaluate(params.batch, {
      model: { id: "native", name: "Native", provider: "fixture" },
      config: params.config,
      auth: { mode: "api-key", apiKey: "synthetic-fixture" },
      signal: params.signal,
      deadlineMonotonicMs: params.deadlineMonotonicMs,
      isAdmissible: params.isAdmissible,
    });
  },
}));

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "synthetic evidence" },
  questions: { q: { type: "boolean" } },
};
const config: OpenClawConfig = {
  agents: { defaults: { decisionModel: "fixture/native@synthetic-profile" } },
};
function accepted(costUsd?: number): ProviderDecisionOutcomeV2 {
  return {
    status: "ok",
    result: {
      model: "provider-reported-alias",
      answers: { q: { type: "boolean", probabilityTrue: 0.8 } },
      usage: { inputTokens: 100, ...(costUsd !== undefined ? { costUsd } : {}) },
    },
  };
}

function registered(evaluate: DecisionProviderV2["evaluate"]) {
  preparation.billing = {
    unit: "tokens",
    source: "provider-catalog",
    usdPerMillion: { input: 2, output: 0 },
  };
  const builder = createTestPluginRegistry({
    modelAuth: { isProviderApiKeyConfigured: () => true },
  } as unknown as PluginRuntime);
  const record = createPluginRecord({
    id: "decision-owner",
    source: "/synthetic/index.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { decisionProviders: ["fixture"] },
  });
  const api = builder.createApi(record, { config });
  runPluginRegisterSyncInRegistry(
    (registration) =>
      registration.registerDecisionProvider({
        id: "fixture",
        contractVersion: 2,
        provider: { label: "Fixture", auth: [] },
        evaluate,
      }),
    api,
    builder.registry,
    record.id,
  );
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  setRuntimeConfigSnapshot(config);
  const events: Array<{
    event: Extract<DiagnosticEventPayload, { type: "model.usage" }>;
    hostPluginId: unknown;
    trusted: boolean;
  }> = [];
  const stop = onTrustedInternalDiagnosticEvent(
    markTrustedOtelDiagnosticListener((event, metadata, privateData) => {
      if (event.type === "model.usage") {
        events.push({
          event,
          hostPluginId: Reflect.get(privateData, "hostPluginId"),
          trusted: metadata.trusted,
        });
      }
    }),
  );
  onTestFinished(async () => {
    stop();
    prepareDecisionProviderReload(builder.registry, new Set([record.id]));
    await getPluginInstance(record)?.dispose();
  });
  const run = (signal = new AbortController().signal) =>
    api.runtime.decisions.evaluateV2(batch, {
      purpose: "accounting-fixture",
      rubricVersion: "v2",
      timeoutMs: 5000,
      signal,
    });
  return { ...builder, record, run, events };
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  resetDiagnosticEventsForTest();
});

it.each([
  { name: "prepared route estimate", costUsd: undefined, expected: 0.0002 },
  { name: "provider billed zero", costUsd: 0, expected: 0 },
])("records one accepted observation with $name", async ({ costUsd, expected }) => {
  const outcome = accepted(costUsd);
  const host = registered(async () => outcome);
  expect(await host.run()).toMatchObject(outcome);
  expect(host.events).toEqual([
    {
      trusted: true,
      hostPluginId: host.record.id,
      event: expect.objectContaining({
        type: "model.usage",
        provider: "fixture",
        model: "native",
        usage: { input: 100 },
        costUsd: expected,
      }),
    },
  ]);
});

it("keeps unknown route pricing absent after accepting provider usage", async () => {
  const host = registered(async () => accepted());
  preparation.billing = undefined;
  expect(await host.run()).toMatchObject(accepted());
  expect(host.events).toHaveLength(1);
  expect(host.events[0]?.event.usage).toEqual({ input: 100 });
  expect(host.events[0]?.event).not.toHaveProperty("costUsd");
});

it("does not record a provider result rejected by host validation", async () => {
  const host = registered(async () => ({
    status: "ok",
    result: {
      model: "native",
      answers: { q: { type: "boolean", probabilityTrue: 2 } },
      usage: { inputTokens: 100, costUsd: 1 },
    },
  }));
  await expect(host.run()).resolves.toEqual({ status: "unavailable", reason: "invalid-response" });
  expect(host.events).toEqual([]);
});

it.each(["provider retirement", "consumer retirement", "cancellation"] as const)(
  "discards late successful usage after %s",
  async (interruption) => {
    const started = createDeferredCore();
    const release = createDeferredCore();
    const host = registered(async () => {
      started.resolve();
      await release.promise;
      return accepted(1);
    });
    const controller = new AbortController();
    const pending = host.run(controller.signal);
    await started.promise;
    if (interruption === "provider retirement") {
      host.registry.decisionProviders[0]!.host.retire();
    } else if (interruption === "consumer retirement") {
      prepareDecisionProviderReload(host.registry, new Set([host.record.id]));
    } else {
      controller.abort(new Error("fixture cancelled"));
    }
    expect(host.events).toEqual([]);
    release.resolve();
    if (interruption === "provider retirement") {
      await expect(pending).resolves.toEqual({ status: "unavailable", reason: "retiring" });
    } else {
      await expect(pending).rejects.toThrow(
        interruption === "cancellation"
          ? "fixture cancelled"
          : "Decision consumer authority closed",
      );
    }
    expect(host.events).toEqual([]);
  },
);

import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { evaluateAttemptDecisionToolPrefilter } from "../agents/embedded-agent-runner/run/attempt-decision-prefilter.js";
import { createDecisionTool } from "../agents/tools/decision-tool.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionEvaluateOptionsV2 } from "../decisions/execution-types.js";
import { prepareDecisionProviderReload } from "../decisions/provider-reload.js";
import type { DecisionProviderV2 } from "../decisions/provider-types.js";
import * as decisionRuntime from "../decisions/runtime.js";
import type { DecisionBatchV2, ProviderDecisionOutcomeV2 } from "../decisions/types-v2.js";
import type { DecisionBatch } from "../decisions/types.js";
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

// The registered provider host, lifecycle, SDK wrapper and accounting stay real.
// mock-isolation: Supply prepared adapter outcomes; real provider validation has integration proof.
vi.mock("../agents/decision-inference.js", () => ({
  executePreparedDecision: (
    params: Parameters<typeof import("../agents/decision-inference.js").executePreparedDecision>[0],
  ) => {
    params.onPreparedBilling?.({
      provider: "fixture",
      model: params.modelId.split("@")[0]!,
      billing: preparation.billing,
    });
    return params.provider.evaluate(params.batch, {
      model: { id: params.modelId.split("@")[0]!, name: "Native", provider: "fixture" },
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
const operationOptions = {
  purpose: "accounting-fixture",
  rubricVersion: "v2",
  timeoutMs: 5000,
};
function usageEvent(costUsd: number, agentId?: string) {
  return expect.objectContaining({
    type: "model.usage",
    provider: "fixture",
    model: "native",
    usage: { input: 100 },
    costUsd,
    ...(agentId ? { agentId } : {}),
  });
}
function accepted(costUsd?: number): Extract<ProviderDecisionOutcomeV2, { status: "ok" }> {
  return {
    status: "ok",
    result: {
      model: "provider-reported-alias",
      answers: { q: { type: "boolean", probabilityTrue: 0.8 } },
      usage: { inputTokens: 100, ...(costUsd !== undefined ? { costUsd } : {}) },
    },
  };
}

function registered(evaluate: DecisionProviderV2["evaluate"], selectedConfig = config) {
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
  const api = builder.createApi(record, { config: selectedConfig });
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
  setRuntimeConfigSnapshot(selectedConfig);
  const consumer = createPluginRecord({
    id: "decision-consumer",
    source: "/synthetic/consumer.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  const consumerApi = builder.createApi(consumer, { config: selectedConfig });
  runPluginRegisterSyncInRegistry(() => {}, consumerApi, builder.registry, consumer.id);
  builder.registry.plugins.push(consumer);
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
    await getPluginInstance(consumer)?.dispose();
    await getPluginInstance(record)?.dispose();
  });
  const run = (signal = new AbortController().signal) =>
    consumerApi.runtime.decisions.evaluateV2(batch, {
      ...operationOptions,
      signal,
    });
  return { ...builder, record, consumer, api: consumerApi, run, events, config: selectedConfig };
}

function pendingDecision(costUsd?: number) {
  const started = createDeferredCore();
  const release = createDeferredCore();
  const evaluate = vi.fn<DecisionProviderV2["evaluate"]>(async () => {
    started.resolve();
    await release.promise;
    return accepted(costUsd);
  });
  return { ...registered(evaluate), evaluate, started, release };
}

afterEach(() => {
  vi.restoreAllMocks();
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
      hostPluginId: host.consumer.id,
      event: usageEvent(expected),
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

it("does not record usage for a rejected prepared outcome", async () => {
  const host = registered(async () => ({
    status: "unavailable",
    reason: "invalid-response",
  }));
  await expect(host.run()).resolves.toEqual({ status: "unavailable", reason: "invalid-response" });
  expect(host.events).toEqual([]);
});

it.each(["provider retirement", "consumer retirement", "cancellation"] as const)(
  "discards late successful usage after %s",
  async (interruption) => {
    const host = pendingDecision(1);
    const { started, release } = host;
    const controller = new AbortController();
    const pending = host.run(controller.signal);
    await started.promise;
    if (interruption === "provider retirement") {
      host.registry.decisionProviders[0]!.host.retire();
    } else if (interruption === "consumer retirement") {
      prepareDecisionProviderReload(host.registry, new Set([host.consumer.id]));
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

const v1Batch: DecisionBatch = {
  state: "synthetic evidence",
  questions: { q: { type: "boolean" } },
};
const entries = [
  "core-v1",
  "core-v2",
  "registry-v1",
  "registry-v2",
  "plugin-v1",
  "plugin-v2",
  "tool",
  "prefilter",
] as const;
type Entry = (typeof entries)[number];
function invoke(
  entry: Entry,
  host: ReturnType<typeof registered>,
  signal: AbortSignal | DecisionEvaluateOptionsV2,
  assertActive = () => {},
) {
  const options =
    signal instanceof AbortSignal
      ? {
          ...operationOptions,
          signal,
          agentId: "operation-owner",
        }
      : signal;
  switch (entry) {
    case "core-v1":
      return decisionRuntime.evaluateDecision(v1Batch, options);
    case "core-v2":
      return decisionRuntime.evaluateDecisionV2(batch, options);
    case "registry-v1":
      return decisionRuntime.evaluateDecisionInRegistry(v1Batch, options, host.registry, config);
    case "registry-v2":
      return decisionRuntime.evaluateDecisionV2InRegistry(batch, options, host.registry, config);
    case "plugin-v1":
      return host.api.runtime.decisions.evaluate(v1Batch, options);
    case "plugin-v2":
      return host.api.runtime.decisions.evaluateV2(batch, options);
    case "tool":
      return createDecisionTool("operation-owner", { config })!.execute(
        "accounting",
        v1Batch,
        options.signal,
      );
    case "prefilter":
      break;
  }
  return evaluateAttemptDecisionToolPrefilter({
    config: host.config,
    agentId: "operation-owner",
    supportsTurnScopedToolRestrictions: true,
    assertActive,
    userMessage: "Hello",
    signal: options.signal,
  });
}
function ready(entry: Entry) {
  const evaluate = vi.fn<DecisionProviderV2["evaluate"]>(async (input) => ({
    ...accepted(),
    result: {
      ...accepted().result,
      answers: Object.fromEntries(
        Object.keys(input.questions).map((id) => [
          id,
          { type: "boolean" as const, probabilityTrue: 0.1 },
        ]),
      ),
    },
  }));
  const selectedConfig =
    entry === "prefilter"
      ? {
          agents: {
            defaults: { ...config.agents!.defaults, experimental: { decisionAssistance: true } },
          },
        }
      : config;
  const host = registered(evaluate, selectedConfig);
  return { ...host, evaluate };
}

it.each(entries)("records exactly one accepted observation at %s", async (entry) => {
  const host = ready(entry);
  for (let call = 1; call <= 2; call++) {
    await invoke(entry, host, new AbortController().signal);
    expect(host.evaluate).toHaveBeenCalledTimes(call);
    expect(host.events).toHaveLength(call);
  }
  expect(host.events[0]).toMatchObject({
    trusted: true,
    hostPluginId: entry.startsWith("plugin") ? host.consumer.id : undefined,
    event: {
      provider: "fixture",
      model: "native",
      agentId: "operation-owner",
      usage: { input: 100 },
      costUsd: 0.0002,
    },
  });
  expect(host.events[0]!.event).not.toHaveProperty("sessionKey");
  expect(host.registry.decisionProviders[0]!.host.inspect(config).activeRequests).toBe(0);
});

const directEntries = ["core-v1", "core-v2", "registry-v1", "registry-v2"] as const;

it.each(directEntries)(
  "keeps admitted cancellation and exactly-once accounting after %s replaces its signal",
  async (entry) => {
    const host = pendingDecision();
    const { started, release, evaluate } = host;
    const admitted = new AbortController();
    const replacement = new AbortController();
    const options = {
      ...operationOptions,
      purpose: "signal-replacement",
      signal: admitted.signal,
      agentId: "operation-owner",
    };
    const pending = invoke(entry, host, options);
    try {
      await started.promise;
      options.signal = replacement.signal;
      replacement.abort(new Error("replacement cancelled"));
      expect(host.events).toEqual([]);
      release.resolve();
      await expect(pending).resolves.toMatchObject({ status: "ok", result: accepted().result });
      expect(host.events).toEqual([
        {
          trusted: true,
          hostPluginId: undefined,
          event: usageEvent(0.0002, "operation-owner"),
        },
      ]);
      expect(evaluate).toHaveBeenCalledOnce();
      expect(host.registry.decisionProviders[0]!.host.inspect(config).activeRequests).toBe(0);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  },
);

it.each(directEntries)(
  "still cancels %s under its admitted signal after replacement with a live signal",
  async (entry) => {
    const host = pendingDecision();
    const { started, release, evaluate } = host;
    const admitted = new AbortController();
    const options = {
      ...operationOptions,
      purpose: "signal-replacement",
      signal: admitted.signal,
    };
    const pending = invoke(entry, host, options);
    const rejected = expect(pending).rejects.toThrow("admitted cancelled");
    try {
      await started.promise;
      options.signal = new AbortController().signal;
      admitted.abort(new Error("admitted cancelled"));
      release.resolve();
      await rejected;
      expect(evaluate).toHaveBeenCalledOnce();
      expect(host.events).toEqual([]);
      expect(host.registry.decisionProviders[0]!.host.inspect(config).activeRequests).toBe(0);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  },
);

it.each(directEntries)(
  "reads %s caller signal accessor once for dispatch and completion",
  async (entry) => {
    const host = ready(entry);
    const admitted = new AbortController();
    const replacement = new AbortController();
    replacement.abort(new Error("unadmitted accessor signal"));
    let reads = 0;
    await expect(
      invoke(entry, host, {
        ...operationOptions,
        purpose: "signal-accessor",
        get signal() {
          return ++reads === 1 ? admitted.signal : replacement.signal;
        },
      }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(reads).toBe(1);
    expect(host.evaluate).toHaveBeenCalledOnce();
    expect(host.events).toHaveLength(1);
  },
);

it.each(["registry-v1", "registry-v2"] as const)(
  "preserves %s contract errors for absent options or signal",
  async (entry) => {
    const host = ready(entry);
    const evaluate =
      entry === "registry-v1"
        ? decisionRuntime.evaluateDecisionInRegistry
        : decisionRuntime.evaluateDecisionV2InRegistry;
    const input = entry === "registry-v1" ? v1Batch : batch;
    for (const options of [
      undefined,
      null,
      { purpose: "missing-signal", rubricVersion: "v2", timeoutMs: 5000 },
    ]) {
      await expect(
        Reflect.apply(evaluate, undefined, [input, options, host.registry, config]),
      ).rejects.toThrow("Invalid decision contract");
    }
    expect(host.evaluate).not.toHaveBeenCalled();
    expect(host.events).toEqual([]);
  },
);

function onOperationSettled(callback: () => void) {
  const v1 = decisionRuntime.evaluateDecisionOperation;
  const v2 = decisionRuntime.evaluateDecisionV2Operation;
  vi.spyOn(decisionRuntime, "evaluateDecisionOperation").mockImplementation(async (...args) => {
    const evaluation = await v1(...args);
    callback();
    return evaluation;
  });
  vi.spyOn(decisionRuntime, "evaluateDecisionV2Operation").mockImplementation(async (...args) => {
    const evaluation = await v2(...args);
    callback();
    return evaluation;
  });
}

it.each(["plugin-v1", "plugin-v2", "tool", "prefilter"] as const)(
  "records no usage when %s cancels at the actual outer-await handoff",
  async (entry) => {
    const host = ready(entry);
    const controller = new AbortController();
    const order: string[] = [];
    onOperationSettled(() => {
      order.push("lower-settled");
      expect(host.events).toEqual([]);
      controller.abort(new Error("handoff cancelled"));
      order.push("aborted");
    });
    await expect(invoke(entry, host, controller.signal)).rejects.toThrow("handoff cancelled");
    order.push("outer-rejected");
    expect(order).toEqual(["lower-settled", "aborted", "outer-rejected"]);
    expect(host.evaluate).toHaveBeenCalledOnce();
    expect(host.events).toEqual([]);
    expect(host.registry.decisionProviders[0]!.host.inspect(config).activeRequests).toBe(0);
  },
);

it.each(["plugin-v1", "plugin-v2"] as const)(
  "records no usage when %s consumer retires at the outer-await handoff",
  async (entry) => {
    const host = ready(entry);
    let disposal:
      | ReturnType<NonNullable<ReturnType<typeof getPluginInstance>>["dispose"]>
      | undefined;
    onOperationSettled(() => {
      disposal = getPluginInstance(host.consumer)!.dispose();
    });
    try {
      await expect(invoke(entry, host, new AbortController().signal)).rejects.toThrow(
        'Plugin "decision-consumer" runtime is no longer active.',
      );
      expect(host.evaluate).toHaveBeenCalledOnce();
      expect(host.events).toEqual([]);
      expect(getPluginInstance(host.record)!.acceptingCalls).toBe(true);
    } finally {
      await disposal;
    }
  },
);

it("records no prefilter usage after its active call closes at the outer-await handoff", async () => {
  const host = ready("prefilter");
  let active = true;
  onOperationSettled(() => {
    active = false;
  });
  await expect(
    invoke("prefilter", host, new AbortController().signal, () => {
      if (!active) {
        throw new Error("active call closed");
      }
    }),
  ).rejects.toThrow("active call closed");
  expect(host.events).toEqual([]);
});

it.each(["plugin-v1", "plugin-v2", "tool", "prefilter"] as const)(
  "does not reject an accepted %s result after its usage listener queues cancellation",
  async (entry) => {
    const host = ready(entry);
    const controller = new AbortController();
    const stop = onTrustedInternalDiagnosticEvent(
      markTrustedOtelDiagnosticListener((event) => {
        if (event.type === "model.usage") {
          queueMicrotask(() => controller.abort(new Error("after acceptance")));
        }
      }),
    );
    try {
      await invoke(entry, host, controller.signal);
      expect(controller.signal.aborted).toBe(true);
      expect(host.events).toHaveLength(1);
    } finally {
      stop();
    }
  },
);

it.each(["plugin-v1", "plugin-v2"] as const)(
  "does not reject accepted %s usage when the listener queues consumer disposal",
  async (entry) => {
    const host = ready(entry);
    let disposal:
      | ReturnType<NonNullable<ReturnType<typeof getPluginInstance>>["dispose"]>
      | undefined;
    const stop = onTrustedInternalDiagnosticEvent(
      markTrustedOtelDiagnosticListener((event) => {
        if (event.type === "model.usage") {
          queueMicrotask(() => {
            disposal = getPluginInstance(host.consumer)!.dispose();
          });
        }
      }),
    );
    try {
      await invoke(entry, host, new AbortController().signal);
      expect(disposal).toBeDefined();
      expect(host.events).toHaveLength(1);
    } finally {
      stop();
      await disposal;
    }
  },
);

it.each(["core-v1", "registry-v1", "plugin-v1"] as const)(
  "does not account for lossy V1 output at %s",
  async (entry) => {
    const host = registered(async () => accepted(0));
    await expect(invoke(entry, host, new AbortController().signal)).resolves.toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
    expect(host.events).toEqual([]);
  },
);

it.each([undefined, { units: { unit: "decision-units" as const, amount: 2 } }])(
  "leaves missing or units-only usage eventless (%j)",
  async (usage) => {
    const host = registered(async () => ({
      ...accepted(),
      result: { ...accepted().result, usage },
    }));
    await host.run();
    expect(host.events).toEqual([]);
  },
);

it("respects disabled diagnostics without changing an accepted result", async () => {
  const outcome = accepted(0);
  const host = registered(async () => outcome);
  setRuntimeConfigSnapshot({ ...config, diagnostics: { enabled: false } });
  expect(await host.run()).toMatchObject(outcome);
  expect(host.events).toEqual([]);
});

it("keeps interleaved agent, model and consumer attribution invocation-local", async () => {
  const started = [createDeferredCore(), createDeferredCore()];
  const release = [createDeferredCore(), createDeferredCore()];
  let calls = 0;
  const host = registered(async () => {
    const index = calls++;
    started[index]!.resolve();
    await release[index]!.promise;
    return accepted(0);
  });
  const other = createPluginRecord({
    id: "other-consumer",
    source: "/synthetic/other.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  const api = host.createApi(other, { config });
  runPluginRegisterSyncInRegistry(() => {}, api, host.registry, other.id);
  host.registry.plugins.push(other);
  setRuntimeConfigSnapshot({
    agents: {
      entries: {
        first: { decisionModel: "fixture/native@first-profile" },
        second: { decisionModel: "fixture/other@second-profile" },
      },
    },
  });
  const options = {
    ...operationOptions,
    purpose: "interleaved",
    signal: new AbortController().signal,
  };
  const pending: Promise<unknown>[] = [];
  try {
    pending.push(host.api.runtime.decisions.evaluateV2(batch, { ...options, agentId: "first" }));
    await started[0]!.promise;
    pending.push(api.runtime.decisions.evaluateV2(batch, { ...options, agentId: "second" }));
    await started[1]!.promise;
    release[1]!.resolve();
    await pending[1];
    release[0]!.resolve();
    await pending[0];
    expect(host.events).toMatchObject([
      {
        hostPluginId: other.id,
        event: { agentId: "second", provider: "fixture", model: "other", costUsd: 0 },
      },
      {
        hostPluginId: host.consumer.id,
        event: { agentId: "first", provider: "fixture", model: "native", costUsd: 0 },
      },
    ]);
  } finally {
    for (const gate of release) {
      gate.resolve();
    }
    await Promise.allSettled(pending);
    await getPluginInstance(other)?.dispose();
  }
});

it.each([null, undefined])(
  "keeps explicit absent registry %j network-free for both contracts",
  async (registry) => {
    const host = ready("core-v2");
    const options = {
      ...operationOptions,
      purpose: "missing-registry",
      signal: new AbortController().signal,
    };
    await expect(
      decisionRuntime.evaluateDecisionInRegistry(v1Batch, options, registry, config),
    ).resolves.toEqual({ status: "unavailable", reason: "not-configured" });
    await expect(
      decisionRuntime.evaluateDecisionV2InRegistry(batch, options, registry, config),
    ).resolves.toEqual({ status: "unavailable", reason: "not-configured" });
    expect(host.evaluate).not.toHaveBeenCalled();
    expect(host.events).toEqual([]);
  },
);

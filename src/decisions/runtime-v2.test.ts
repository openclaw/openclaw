import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { evaluateAttemptDecisionToolPrefilter } from "../agents/embedded-agent-runner/run/attempt-decision-prefilter.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { runPluginRegisterSyncInRegistry } from "../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { decisionBatchV1ToV2 } from "./compatibility.js";
import type { DecisionProviderContextV2 } from "./provider-context.js";
import {
  evaluateDecisionInRegistry,
  evaluateDecisionV2InRegistry,
  prepareDecisionProviderReload,
} from "./runtime.js";
import { answer, batch, config, options, registered } from "./runtime.test-support.js";
import type { DecisionEvaluateOptionsV2, DecisionProviderV2 } from "./types-v2.js";
import type { DecisionProviderV1 } from "./types.js";

// mock-isolation: Keep model preparation and credential discovery outside decision host contract tests.
vi.mock("../agents/decision-inference.js", () => ({
  executePreparedDecision: (params: {
    provider: DecisionProviderV2;
    batch: Parameters<DecisionProviderV2["evaluate"]>[0];
    modelId: string;
    options: DecisionEvaluateOptionsV2;
    signal: AbortSignal;
    deadlineMonotonicMs: number;
    isAdmissible: () => boolean;
  }) =>
    params.provider.evaluate(params.batch, {
      model: { id: params.modelId, name: params.modelId, provider: "fixture" },
      config,
      agentId: params.options.agentId,
      auth: { mode: "api-key", apiKey: "synthetic-fixture" },
      signal: params.signal,
      deadlineMonotonicMs: params.deadlineMonotonicMs,
      isAdmissible: params.isAdmissible,
    }),
}));

const richer = decisionBatchV1ToV2(batch)!;
afterEach(() => {
  resetDiagnosticEventsForTest();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

function native(evaluate: DecisionProviderV2["evaluate"]) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "owner",
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
  onTestFinished(async () => {
    prepareDecisionProviderReload(builder.registry, new Set([record.id]));
    await getPluginInstance(record)?.dispose();
  });
  return { ...builder, record, api };
}

it.each([1, 2] as const)(
  "prefilters through a registered V%d provider without narrowing native result facts",
  async (version) => {
    const selected = {
      agents: {
        defaults: {
          decisionModel: "fixture/fixture-v1",
          experimental: { decisionAssistance: true },
        },
      },
    };
    const evaluate = vi.fn(async () => ({
      status: "ok" as const,
      result: {
        model: "fixture-v1",
        answers: {
          missing_request_context: { type: "boolean" as const, probabilityTrue: 0.1 },
          next_response_needs_tools: { type: "boolean" as const, probabilityTrue: 0.1 },
        },
        ...(version === 2 ? { metadata: { requestId: "synthetic" } } : {}),
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          ...(version === 2
            ? {
                costUsd: 0,
                units: { unit: "decision-units" as const, amount: 2 },
                raw: { billed: false },
              }
            : {}),
        },
      },
    }));
    const host = version === 1 ? registered(evaluate) : native(evaluate);
    const events: DiagnosticEventPayload[] = [];
    const stop = onTrustedInternalDiagnosticEvent(
      markTrustedOtelDiagnosticListener((event) => {
        if (event.type === "model.usage") {
          events.push(event);
        }
      }),
    );
    onTestFinished(stop);
    setRuntimeConfigSnapshot(selected);
    const result = await evaluateAttemptDecisionToolPrefilter({
      config: selected,
      agentId: "main",
      supportsTurnScopedToolRestrictions: true,
      assertActive: () => {},
      userMessage: "Hello",
      signal: new AbortController().signal,
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(events).toEqual([
      expect.objectContaining({
        type: "model.usage",
        provider: "fixture",
        model: "fixture-v1",
        agentId: "main",
        usage: { input: 4, output: 2 },
        ...(version === 2 ? { costUsd: 0 } : {}),
      }),
    ]);
    expect(result).toMatchObject({
      shouldPruneTools: true,
      status: "proposed",
      reason: "conversational",
    });
    expect(host.registry.decisionProviders[0]!.host.inspect(selected).activeRequests).toBe(0);
  },
);

it.each([1, 2] as const)(
  "shares V1/V2 priority admission and physical settlement on a V%d provider",
  async (providerVersion) => {
    const started = Array.from({ length: 4 }, () => createDeferredCore());
    const release = Array.from({ length: 4 }, () => createDeferredCore());
    const cancelled = new AbortController();
    let calls = 0;
    const callback = async () => {
      const index = calls++;
      if (index < release.length) {
        started[index]!.resolve();
        // Both native and bridged calls keep their slots through abort-ignoring cleanup.
        await release[index]!.promise;
      }
      return answer;
    };
    const host = providerVersion === 1 ? registered(callback) : native(callback);
    setRuntimeConfigSnapshot(config);
    const providerHost = host.registry.decisionProviders[0]!.host;
    const evaluate = (version: 1 | 2, requestOptions: DecisionEvaluateOptionsV2) =>
      version === 1
        ? host.api.runtime.decisions.evaluate(batch, requestOptions)
        : host.api.runtime.decisions.evaluateV2(richer, requestOptions);
    const pending: ReturnType<typeof evaluate>[] = [];
    const overloaded = { status: "unavailable", reason: "overloaded" };
    try {
      for (const [index, priority] of (["optional", "requested", "optional"] as const).entries()) {
        const request = evaluate(index === 1 ? 1 : 2, {
          ...options(),
          priority,
          ...(index === 0 ? { signal: cancelled.signal } : {}),
        });
        pending.push(request);
        await Promise.race([started[index]!.promise, request]);
        expect(calls).toBe(index + 1);
      }
      for (const version of [1, 2] as const) {
        await expect(evaluate(version, { ...options(), priority: "optional" })).resolves.toEqual(
          overloaded,
        );
      }
      expect(calls).toBe(3);
      const fourth = evaluate(providerVersion, options());
      pending.push(fourth);
      await Promise.race([started[3]!.promise, fourth]);
      expect(calls).toBe(4);
      for (const version of [1, 2] as const) {
        await expect(evaluate(version, options())).resolves.toEqual(overloaded);
      }

      const reason = new Error("V2 caller cancelled");
      const rejected = expect(pending[0]!).rejects.toBe(reason);
      cancelled.abort(reason);
      expect(providerHost.inspect(config).activeRequests).toBe(4);
      await expect(evaluate(2, options())).resolves.toEqual(overloaded);
      release[0]!.resolve();
      await rejected;
      expect(providerHost.inspect(config).activeRequests).toBe(3);
      for (const version of [1, 2] as const) {
        await expect(evaluate(version, { ...options(), priority: "optional" })).resolves.toEqual(
          overloaded,
        );
      }
      expect(calls).toBe(4);
      release[1]!.resolve();
      await pending[1];
      for (const version of [1, 2] as const) {
        await expect(
          evaluate(version, { ...options(), priority: "optional" }),
        ).resolves.toMatchObject({ status: "ok" });
      }
      expect(calls).toBe(6);
    } finally {
      for (const releaseGate of release) {
        releaseGate.resolve();
      }
      await Promise.allSettled(pending);
    }
    expect(providerHost.inspect(config).activeRequests).toBe(0);
  },
);

it("rejects invalid V2 priority before provider dispatch", async () => {
  const evaluate = vi.fn<DecisionProviderV2["evaluate"]>(async () => answer);
  const host = native(evaluate);
  const requestOptions = options();
  Reflect.set(requestOptions, "priority", "urgent");
  await expect(host.api.runtime.decisions.evaluateV2(richer, requestOptions)).rejects.toThrow(
    "Invalid decision contract",
  );
  expect(evaluate).not.toHaveBeenCalled();
});

it("leaves V2 credential admission to preparation without a global readiness claim", async () => {
  const evaluate = vi.fn<DecisionProviderV2["evaluate"]>(async () => answer);
  const host = native(evaluate);
  const status = host.registry.decisionProviders[0]!.host.inspect(config);
  expect(status).not.toHaveProperty("credentialReady");
  expect(status.callable).toBe(true);
  await expect(host.api.runtime.decisions.evaluateV2(richer, options())).resolves.toMatchObject({
    status: "ok",
  });
  expect(evaluate).toHaveBeenCalledOnce();
  const providerHost = host.registry.decisionProviders[0]!.host;
  providerHost.retire();
  const retired = providerHost.inspect(config);
  expect(retired).not.toHaveProperty("credentialReady");
  expect(retired.callable).toBe(false);
});

it.each([undefined, false, true])(
  "preserves the explicit V2 owner independently of LLM override permission (%j)",
  async (allowAgentIdOverride) => {
    const evaluate = vi.fn<DecisionProviderV2["evaluate"]>(async () => answer);
    const host = native(evaluate);
    setRuntimeConfigSnapshot({
      agents: {
        defaults: { model: "fixture/primary" },
        entries: { specialist: { decisionModel: "fixture/specialist-v2" } },
      },
      plugins: {
        entries: {
          owner: {
            llm: { allowAgentIdOverride, allowedCompletionModels: ["fixture/specialist-v2"] },
          },
        },
      },
    });
    await expect(
      withGatewayToolCallerIdentity(
        { agentId: "ambient", sessionKey: "agent:ambient:fixture" },
        () =>
          host.api.runtime.decisions.evaluateV2(richer, { ...options(), agentId: "specialist" }),
      ),
    ).resolves.toMatchObject({ status: "ok" });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({
      agentId: "specialist",
      model: { id: "specialist-v2" },
    });
  },
);

it.each(["specialist-v2", "other"])(
  "authorizes the bare model while retaining an explicit credential profile (%s)",
  async (model) => {
    const evaluate = vi.fn<DecisionProviderV2["evaluate"]>(async () => answer);
    const host = native(evaluate);
    setRuntimeConfigSnapshot({
      agents: {
        entries: { specialist: { decisionModel: `fixture/${model}@fixture:agent` } },
      },
      plugins: {
        entries: {
          owner: { llm: { allowedCompletionModels: ["fixture/specialist-v2"] } },
        },
      },
    });
    const pending = host.api.runtime.decisions.evaluateV2(richer, {
      ...options(),
      agentId: "specialist",
    });
    if (model === "other") {
      await expect(pending).rejects.toThrow(/not allowlisted/);
      expect(evaluate).not.toHaveBeenCalled();
      return;
    }
    await expect(pending).resolves.toMatchObject({ status: "ok" });
    expect(evaluate).toHaveBeenCalledOnce();
    // This fixture captures the host handoff before credential preparation splits the profile.
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({
      agentId: "specialist",
      model: { id: "specialist-v2@fixture:agent" },
    });
  },
);

it.each([
  { allowedCompletionModels: ["fixture/other"] },
  { allowedCompletionModels: [] },
  { allowedCompletionModels: ["invalid"] },
])(
  "enforces the consumer completion allowlist before V2 dispatch (%j)",
  async ({ allowedCompletionModels }) => {
    const evaluate = vi.fn<DecisionProviderV2["evaluate"]>(async () => answer);
    const host = native(evaluate);
    setRuntimeConfigSnapshot({
      ...config,
      plugins: { entries: { owner: { llm: { allowedCompletionModels } } } },
    });
    await expect(host.api.runtime.decisions.evaluateV2(richer, options())).rejects.toThrow(
      /not allowlisted|no valid models/,
    );
    expect(evaluate).not.toHaveBeenCalled();
  },
);

it("runs lossless V2 input through a V1 owner and rejects native-only input without dispatch", async () => {
  const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
  const host = registered(evaluate);
  await expect(
    evaluateDecisionV2InRegistry(richer, options(), host.registry, config),
  ).resolves.toMatchObject({ status: "ok", result: answer.result });
  expect(evaluate.mock.calls[0]?.[0]).toEqual(batch);
  await expect(
    evaluateDecisionV2InRegistry(
      { ...richer, state: { type: "list", items: [{ id: "a", content: "a" }] } },
      options(),
      host.registry,
      config,
    ),
  ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
  expect(evaluate).toHaveBeenCalledOnce();
});

it("keeps V1 admission errors terminal through a V2 call after adapter cleanup", async () => {
  const terminal = new Error("consumer closed after admission");
  let admitted = true;
  const host = registered(async (_input, context) => {
    admitted = false;
    try {
      context.isAdmissible?.();
    } catch {
      /* adapter sanitizes while joining cleanup */
    }
    await Promise.resolve();
    return { status: "unavailable", reason: "transport" };
  });
  await expect(
    evaluateDecisionV2InRegistry(richer, options(), host.registry, config, undefined, () => {
      if (!admitted) {
        throw terminal;
      }
      return true;
    }),
  ).rejects.toBe(terminal);
});

it("preserves native abstention in V2 and refuses lossy V1 narrowing", async () => {
  const host = native(async () => ({
    status: "ok",
    result: {
      model: "fixture-v1",
      answers: {
        pick: { type: "choice", choice: null },
        rank: { type: "score", score: 1.3 },
        truth: { type: "boolean", answer: null },
      },
    },
  }));
  await expect(host.api.runtime.decisions.evaluateV2(richer, options())).resolves.toMatchObject({
    status: "ok",
    result: { answers: { truth: { answer: null } } },
  });
  await expect(
    evaluateDecisionInRegistry(batch, options(), host.registry, config),
  ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
});

it("closes V2 physical dispatch authority and joins the outstanding callback during reload", async () => {
  const started = createDeferredCore();
  const release = createDeferredCore();
  let context: DecisionProviderContextV2 | undefined;
  const host = native(async (_batch, current) => {
    context = current;
    started.resolve();
    await release.promise;
    return { status: "unavailable", reason: "transport" };
  });
  const pending = evaluateDecisionV2InRegistry(richer, options(), host.registry, config);
  await started.promise;
  const reload = prepareDecisionProviderReload(host.registry, new Set([host.record.id]));
  expect(context?.isAdmissible()).toBe(false);
  let drained = false;
  void reload.rollback(new AbortController().signal).then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release.resolve();
  await expect(pending).resolves.toEqual({ status: "unavailable", reason: "retiring" });
  await vi.waitFor(() => expect(drained).toBe(true));
});

it.each(["on", "off"] as const)(
  "rejects reasoning %s at the V1 bridge before provider dispatch",
  async (reasoning) => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    const host = registered(evaluate);
    await expect(
      evaluateDecisionV2InRegistry(richer, { ...options(), reasoning }, host.registry, config),
    ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(evaluate).not.toHaveBeenCalled();
  },
);

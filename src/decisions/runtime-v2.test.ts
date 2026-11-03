import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { evaluateAttemptDecisionToolPrefilter } from "../agents/embedded-agent-runner/run/attempt-decision-prefilter.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { decisionBatchV1ToV2 } from "./compatibility.js";
import { createDecisionRegistry, unavailable } from "./contract.test-support.js";
import type { DecisionEvaluateOptionsV2 } from "./execution-types.js";
import type { DecisionProviderContextV2 } from "./provider-context.js";
import { prepareDecisionProviderReload } from "./provider-reload.js";
import type { DecisionProviderV2, DecisionProviderV1 } from "./provider-types.js";
import { evaluateDecisionInRegistry, evaluateDecisionV2InRegistry } from "./runtime.js";
import { answer, batch, config, options, registered } from "./runtime.test-support.js";

// mock-isolation: Keep model preparation and credential discovery outside decision host contract tests.
vi.mock("../agents/decision-inference.js", () => ({
  executePreparedDecision: (
    params: Parameters<typeof import("../agents/decision-inference.js").executePreparedDecision>[0],
  ) =>
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
const assistanceConfig: OpenClawConfig = {
  agents: {
    defaults: { decisionModel: "fixture/fixture-v1", experimental: { decisionAssistance: true } },
  },
};
const prefilter = () =>
  evaluateAttemptDecisionToolPrefilter({
    config: assistanceConfig,
    agentId: "main",
    supportsTurnScopedToolRestrictions: true,
    assertActive: () => {},
    userMessage: "Hello",
    signal: new AbortController().signal,
  });
afterEach(() => {
  resetDiagnosticEventsForTest();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

function native(evaluate: DecisionProviderV2["evaluate"]) {
  const builder = createDecisionRegistry(config, {
    id: "fixture",
    contractVersion: 2,
    provider: { label: "Fixture", auth: [] },
    evaluate,
  });
  const { record, api } = builder;
  setRuntimeConfigSnapshot(config);
  onTestFinished(async () => {
    prepareDecisionProviderReload(builder.registry, new Set([record.id]));
    await getPluginInstance(record)?.dispose();
  });
  return {
    ...builder,
    run: (opts = options()) => api.runtime.decisions.evaluateV2(richer, opts),
  };
}
function mockNative() {
  const evaluate = vi.fn<DecisionProviderV2["evaluate"]>(async () => answer);
  return { ...native(evaluate), evaluate };
}
function legacy(evaluate: DecisionProviderV1["evaluate"] = async () => answer) {
  const callback = vi.fn(evaluate);
  const host = registered(callback);
  const runV2 = (
    opts: DecisionEvaluateOptionsV2 = options(),
    input = richer,
    guard?: () => boolean,
  ) => evaluateDecisionV2InRegistry(input, opts, host.registry, config, undefined, guard);
  return { ...host, callback, runV2 };
}

function selectOwner(agents: OpenClawConfig["agents"], llm: PluginEntryConfig["llm"]) {
  setRuntimeConfigSnapshot({ agents, plugins: { entries: { owner: { llm } } } });
}

it.each([1, 2] as const)(
  "prefilters through a registered V%d provider without narrowing native result facts",
  async (version) => {
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
    setRuntimeConfigSnapshot(assistanceConfig);
    const result = await prefilter();
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
    });
    const status = host.registry.decisionProviders[0]!.host.inspect(assistanceConfig);
    expect(status).toMatchObject({ activeRequests: 0, callable: true });
    if (version === 2) {
      expect(status).not.toHaveProperty("credentialReady");
    }
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
    setRuntimeConfigSnapshot(assistanceConfig);
    const providerHost = host.registry.decisionProviders[0]!.host;
    const evaluate = (version: 1 | 2, requestOptions: DecisionEvaluateOptionsV2) =>
      version === 1
        ? host.api.runtime.decisions.evaluate(batch, requestOptions)
        : host.api.runtime.decisions.evaluateV2(richer, requestOptions);
    const pending: ReturnType<typeof evaluate>[] = [];
    const overloaded = unavailable("overloaded");
    const expectOverloaded = async (priority: "optional" | "requested" = "requested") => {
      for (const version of [1, 2] as const) {
        await expect(evaluate(version, { ...options(), priority })).resolves.toEqual(overloaded);
      }
    };
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
      await expectOverloaded("optional");
      expect(await prefilter()).toMatchObject({ status: "unavailable", shouldPruneTools: false });
      expect(calls).toBe(3);
      // Purpose text must not turn requested work into optional admission.
      const fourth = evaluate(providerVersion, {
        ...options(),
        purpose: "tool-prefilter.semantic-gate",
      });
      pending.push(fourth);
      await Promise.race([started[3]!.promise, fourth]);
      expect(calls).toBe(4);
      await expectOverloaded();

      const reason = new Error("V2 caller cancelled");
      const rejected = expect(pending[0]!).rejects.toBe(reason);
      cancelled.abort(reason);
      expect(providerHost.inspect(config).activeRequests).toBe(4);
      expect(await prefilter()).toMatchObject({ status: "unavailable", shouldPruneTools: false });
      expect(calls).toBe(4);
      await expect(evaluate(2, options())).resolves.toEqual(overloaded);
      release[0]!.resolve();
      await rejected;
      expect(providerHost.inspect(config).activeRequests).toBe(3);
      await expectOverloaded("optional");
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

it.each([
  [undefined, "specialist-v2", false],
  [false, "specialist-v2", false],
  [true, "specialist-v2", false],
  [undefined, "specialist-v2", true],
  [undefined, "other", true],
] as const)(
  "authorizes the explicit V2 owner (override=%s, model=%s, profile=%s)",
  async (allowAgentIdOverride, model, profile) => {
    const { evaluate, ...host } = mockNative();
    const selectedModel = profile ? `${model}@fixture:agent` : model;
    selectOwner(
      {
        ...(!profile ? { defaults: { model: "fixture/primary" } } : {}),
        entries: { specialist: { decisionModel: `fixture/${selectedModel}` } },
      },
      {
        ...(!profile ? { allowAgentIdOverride } : {}),
        allowedCompletionModels: ["fixture/specialist-v2"],
      },
    );
    const run = () => host.run({ ...options(), agentId: "specialist" });
    const pending = profile
      ? run()
      : withGatewayToolCallerIdentity(
          { agentId: "ambient", sessionKey: "agent:ambient:fixture" },
          run,
        );
    if (model === "other") {
      await expect(pending).rejects.toThrow(/not allowlisted/);
      expect(evaluate).not.toHaveBeenCalled();
      return;
    }
    await expect(pending).resolves.toMatchObject({ status: "ok" });
    expect(evaluate).toHaveBeenCalledOnce();
    // Capture the handoff before credential preparation splits any profile suffix.
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({
      agentId: "specialist",
      model: { id: selectedModel },
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
    const { evaluate, ...host } = mockNative();
    selectOwner(config.agents, { allowedCompletionModels });
    await expect(host.run()).rejects.toThrow(/not allowlisted|no valid models/);
    expect(evaluate).not.toHaveBeenCalled();
  },
);

it("runs lossless V2 input through a V1 owner and rejects native-only input without dispatch", async () => {
  const { callback, runV2 } = legacy();
  await expect(runV2()).resolves.toMatchObject({ status: "ok", result: answer.result });
  expect(callback.mock.calls[0]?.[0]).toEqual(batch);
  const input = { ...richer, state: { type: "list" as const, items: [{ id: "a", content: "a" }] } };
  await expect(runV2(options(), input)).resolves.toEqual(unavailable("unsupported-input"));
  expect(callback).toHaveBeenCalledOnce();
});

it("keeps V1 admission errors terminal through a V2 call after adapter cleanup", async () => {
  const terminal = new Error("consumer closed after admission");
  let admitted = true;
  const { runV2 } = legacy(async (_input, context) => {
    admitted = false;
    try {
      context.isAdmissible?.();
    } catch {
      /* adapter sanitizes while joining cleanup */
    }
    await Promise.resolve();
    return unavailable("transport");
  });
  await expect(
    runV2(options(), richer, () => {
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
  await expect(host.run()).resolves.toMatchObject({
    status: "ok",
    result: { answers: { truth: { answer: null } } },
  });
  const narrowed = evaluateDecisionInRegistry(batch, options(), host.registry, config);
  await expect(narrowed).resolves.toEqual(unavailable("unsupported-input"));
});

it("closes V2 physical dispatch authority and joins the outstanding callback during reload", async () => {
  const started = createDeferredCore();
  const release = createDeferredCore();
  let context: DecisionProviderContextV2 | undefined;
  const host = native(async (_batch, current) => {
    context = current;
    started.resolve();
    await release.promise;
    return unavailable("transport");
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
  await expect(pending).resolves.toEqual(unavailable("retiring"));
  await vi.waitFor(() => expect(drained).toBe(true));
});

it.each(["on", "off"] as const)(
  "rejects reasoning %s at the V1 bridge before provider dispatch",
  async (reasoning) => {
    const { callback, runV2 } = legacy();
    await expect(runV2({ ...options(), reasoning })).resolves.toEqual(
      unavailable("unsupported-input"),
    );
    expect(callback).not.toHaveBeenCalled();
  },
);

import { AsyncResource } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { createDecisionTool } from "../agents/tools/decision-tool.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOperatorToolGatewayAuthority } from "../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import * as currentPluginMetadata from "../plugins/current-plugin-metadata-state.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecord,
} from "../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { evaluateDecisionInRegistry, prepareDecisionProviderReload } from "./runtime.js";
import { answer, batch, config, options, registered } from "./runtime.test-support.js";
import type { DecisionProviderV1 } from "./types.js";
import { validateDecisionBatch, validateDecisionResult } from "./validation.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

type Options = ReturnType<typeof options>;
type LlmPolicy = NonNullable<NonNullable<OpenClawConfig["plugins"]>["entries"]>[string]["llm"];
const modelConfig = (
  decisionModel: string | undefined,
  entries: Record<string, string> = {},
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {},
): OpenClawConfig => ({
  agents: {
    defaults: { ...defaults, decisionModel },
    entries: Object.fromEntries(
      Object.entries(entries).map(([id, model]) => [id, { decisionModel: model }]),
    ),
  },
});
function fixture(
  evaluate: DecisionProviderV1["evaluate"] = async () => answer,
  isReady?: () => boolean,
  providerId?: string,
) {
  const call = vi.fn(evaluate);
  const host = registered(call, isReady, providerId);
  const provider = host.registry.decisionProviders[0]!.host;
  return {
    ...host,
    call,
    provider,
    instance: getPluginInstance(host.record)!,
    run: (overrides: Partial<Options> = {}, cfg = config, input = batch, consumerId?: string) =>
      evaluateDecisionInRegistry(
        input,
        { ...options(), ...overrides },
        host.registry,
        cfg,
        consumerId,
      ),
    sdk: (overrides: Partial<Options> = {}) =>
      host.api.runtime.decisions.evaluate(batch, { ...options(), ...overrides }),
    reload: (changed = [host.record.id]) =>
      prepareDecisionProviderReload(host.registry, new Set(changed)),
    inspect: (cfg = config) => provider.inspect(cfg),
  };
}
function blockedFixture() {
  const release = createDeferredCore();
  const host = fixture(async () => {
    await release.promise;
    return answer;
  });
  return { ...host, release: release.resolve };
}
const setPolicy = (llm: LlmPolicy, cfg = config) =>
  setRuntimeConfigSnapshot({
    ...cfg,
    plugins: { entries: { owner: { llm } } },
  });
const waitForAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
const fromAgent = (agentId: string, invoke: () => Promise<unknown>) =>
  withGatewayToolCallerIdentity({ agentId, sessionKey: `agent:${agentId}:fixture` }, invoke);
const expectOk = async (pending: Promise<unknown>) => {
  expect(await pending).toMatchObject({ status: "ok" });
};
const expectUnavailable = async (pending: Promise<unknown>, reason: string) => {
  expect(await pending).toEqual({ status: "unavailable", reason });
};

it.each([
  ["specialist", ["fixture/other"], "not allowlisted"],
  [undefined, ["fixture/other"], "not allowlisted"],
  [undefined, [], "no valid models"],
  [undefined, ["invalid"], "no valid models"],
] as const)("denies SDK policy before dispatch: %s %j %s", async (agentId, models, reason) => {
  const host = fixture();
  setPolicy({ allowedCompletionModels: [...models] });
  await expect(host.sdk({ agentId })).rejects.toThrow(reason);
  expect(host.call).not.toHaveBeenCalled();
});

it.each([
  { role: "global", llm: { allowedCompletionModels: undefined } },
  { role: "global", llm: { allowedCompletionModels: ["fixture/fixture-v1"] } },
  { role: "global", llm: { allowedCompletionModels: ["*"] } },
  { role: "owner", llm: { allowAgentIdOverride: undefined } },
  { role: "owner", llm: { allowAgentIdOverride: false } },
  { role: "owner", llm: { allowAgentIdOverride: true } },
])("selects $role roles independently of override permissions ($llm)", async ({ role, llm }) => {
  const host = fixture();
  const agentId = role === "owner" ? "specialist" : undefined;
  const model = agentId ? "specialist-v1" : "fixture-v1";
  setPolicy(
    {
      allowModelOverride: false,
      allowedModels: [],
      allowedCompletionModels: [`fixture/${model}`],
      ...llm,
    },
    modelConfig(
      agentId ? undefined : "fixture/fixture-v1",
      { main: "fixture/main-role", specialist: "fixture/specialist-v1", disabled: "" },
      { model: "fixture/primary", modelPolicy: { allow: ["fixture/conversation-only"] } },
    ),
  );
  await expectOk(fromAgent(agentId ?? "main", () => host.sdk({ agentId })));
  expect(host.call.mock.calls[0]?.[1]).toMatchObject({ model });
  expect(host.call.mock.calls[0]?.[1].agentId).toBe(agentId);
  if (agentId) {
    for (const disabled of [undefined, "disabled"]) {
      await expectUnavailable(host.sdk({ agentId: disabled }), "disabled");
    }
  }
  expect(host.call).toHaveBeenCalledOnce();
});

it.each(["consumer", "MixedConsumer"])(
  "uses registered consumer %s policy, not provider, ambient plugin or option identity",
  async (consumerId) => {
    const host = fixture();
    const consumer = createPluginRecord({
      id: consumerId,
      source: "/synthetic/consumer.ts",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = host.createApi(consumer, { config });
    host.registry.plugins.push(consumer);
    onTestFinished(async () => {
      await getPluginInstance(consumer)?.dispose();
    });
    setRuntimeConfigSnapshot({
      ...config,
      plugins: {
        entries: {
          owner: { llm: { allowAgentIdOverride: true, allowedCompletionModels: ["*"] } },
          [consumerId.toLowerCase()]: { llm: { allowedCompletionModels: ["fixture/other"] } },
        },
      },
    });
    const spoofed = {
      ...options(),
      consumerId: "owner",
      pluginIdForPolicy: "owner",
      caller: { kind: "context-engine", id: "owner" },
      authority: { allowAgentIdOverride: true },
    };
    await expect(
      withPluginRuntimeGatewayRequestScope(
        { pluginId: "owner", isWebchatConnect: () => false },
        () => api.runtime.decisions.evaluate(batch, spoofed),
      ),
    ).rejects.toThrow(`not allowlisted for completions for plugin "${consumerId}"`);
    await expect(
      api.runtime.decisions.evaluate(batch, { ...spoofed, agentId: "specialist" }),
    ).rejects.toThrow(`not allowlisted for completions for plugin "${consumerId}"`);
    expect(host.call).not.toHaveBeenCalled();
    // Provider configuration is not consumer authorization either.
    await expectOk(host.sdk());
  },
);

it("routes a configured custom TypeSafe model without requiring a catalog preset", async () => {
  const host = fixture(undefined, undefined, "typesafe");
  await expectOk(host.run({}, modelConfig("typesafe/nemotron-deciffusion")));
  expect(host.call).toHaveBeenCalledOnce();
  expect(host.call.mock.calls[0]?.[1].model).toBe("nemotron-deciffusion");
});
it("uses the adopted owner from a collected callback scope without reviving a retired instance", async () => {
  class RetiredRegistry {
    readonly fixtureLabel = "RetiredRegistry";
  }
  const host = fixture();
  setRuntimeConfigSnapshot(config);
  const current = { ...host.registry };
  const resource = (() => {
    const previous = Object.assign(new RetiredRegistry(), host.registry);
    markPluginRegistryActive(previous);
    const retained = host.instance.run(() => new AsyncResource("retired-decision-scope"));
    markPluginRegistryActive(current);
    markPluginRegistryRetired(previous);
    return retained;
  })();
  try {
    await setImmediate();
    expect(queryObjects(RetiredRegistry)).toBe(0);
    const invoke = () => resource.runInAsyncScope(() => host.sdk());
    await expectOk(invoke());
    expect(host.call).toHaveBeenCalledOnce();
    revokePluginRecord(current, host.record);
    await expect(invoke()).rejects.toThrow("runtime is no longer active");
    expect(host.call).toHaveBeenCalledOnce();
  } finally {
    resource.emitDestroy();
    markPluginRegistryRetired(current);
  }
});

it.each([
  { reason: "unsupported-input", attempts: 4, sdk: true },
  { reason: "authentication", attempts: 3, sdk: false },
] as const)(
  "keeps $reason recoverable without poisoning shared health",
  async ({ reason, attempts, sdk }) => {
    let recovered = false;
    const host = fixture(async (_batch, { agentId }) =>
      !recovered && agentId !== "second"
        ? { status: "unavailable", reason, retryAfterMs: 60_000 }
        : answer,
    );
    const run = () => (sdk ? host.sdk() : host.run({ agentId: "first" }));
    setRuntimeConfigSnapshot(config);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await expectUnavailable(run(), reason);
      expect(host.call).toHaveBeenCalledTimes(attempt);
    }
    if (!sdk) {
      await expectOk(host.run({ agentId: "second" }));
    }
    recovered = true;
    await expectOk(run());
    expect(host.call).toHaveBeenCalledTimes(attempts + (sdk ? 1 : 2));
    expect(host.inspect()).toMatchObject({
      callable: true,
      ...(!sdk && { activeRequests: 0, successCount: 2, reasons: { authentication: 3 } }),
    });
  },
);

it("reuses the validated provider snapshots for safe usage, diagnostics and outcomes", async () => {
  let resultReads = 0;
  let reasonReads = 0;
  const host = fixture(async () =>
    Object.defineProperty({ status: "ok", result: answer.result }, "result", {
      get: () =>
        ++resultReads === 1 ? answer.result : { usage: { inputTokens: "private-provider-body" } },
    }),
  );
  expect(await host.run()).toMatchObject({
    ...answer,
    provenance: { providerId: "fixture", rubricVersion: "1" },
  });
  expect(resultReads).toBe(1);
  host.call.mockImplementationOnce(async () =>
    Object.defineProperty({ status: "unavailable", reason: "unsupported-input" }, "reason", {
      get: () => (++reasonReads === 1 ? "unsupported-input" : "private-provider-body"),
    }),
  );
  await expectUnavailable(host.run(), "unsupported-input");
  expect(reasonReads).toBe(1);
});

it("requires a current Gateway binding for scoped operator decisions", async () => {
  const host = fixture();
  setRuntimeConfigSnapshot(config);
  await expect(
    withPluginRuntimeGatewayRequestScope(
      {
        client: createSyntheticPluginRuntimeClient({
          operatorRoleActor: { kind: "operator", profileId: "decision-reader" },
          scopes: ["operator.write"],
        }),
        isWebchatConnect: () => false,
      },
      () => host.sdk(),
    ),
  ).rejects.toThrow("Decision evaluation requires its current Gateway binding.");
  expect(host.call).not.toHaveBeenCalled();
});

it.each([
  { model: "fixture-v1", source: "agent-tool" },
  { model: "fixture-v1@fixture:agent", source: "agent-tool" },
  { model: "shortcut@fixture:agent", source: "direct-tool" },
  { model: "shortcut", source: "direct-tool" },
  { model: "shortcut", source: "unbound-operator" },
] as const)(
  "enforces requester exclusions for $model from $source while preserving independent system decisions",
  async ({ model, source }) => {
    const host = fixture();
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "fixture-normalizer",
          modelIdNormalization: {
            providers: { fixture: { aliases: { shortcut: "fixture-v1" } } },
          },
        },
      ],
    });
    const snapshot = vi
      .spyOn(currentPluginMetadata, "getProcessGatewayPluginMetadataSnapshot")
      .mockReturnValue(metadata);
    onTestFinished(() => snapshot.mockRestore());
    const selected = modelConfig(`fixture/${model}`, {}, { model: "fixture/permitted" });
    selected.agents!.entries = { main: {} };
    setRuntimeConfigSnapshot(selected);
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "decision-reader",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      modelPolicy: prepareOperatorModelPolicy({
        cfg: selected,
        policy: { sourceAgent: "main", allow: ["fixture/*"], deny: ["fixture/fixture-v1"] },
        manifestPlugins: metadata,
      }),
    });
    const invoke = () => host.sdk();
    await expect(
      source === "agent-tool"
        ? withGatewayToolCallerIdentity(
            { agentId: "main", sessionKey: "agent:main:reader", operatorAuthority },
            invoke,
          )
        : withOperatorToolGatewayAuthority(
            {
              authenticatedUserProfile: {
                profileId: operatorAuthority.profileId,
                displayName: "Decision Reader",
                hasAvatar: false,
                updatedAt: 1,
              },
              scopes: ["operator.write"],
              ...(source === "direct-tool" ? { operatorRunAuthority: operatorAuthority } : {}),
            },
            invoke,
          ),
    ).rejects.toThrow(
      source === "unbound-operator"
        ? "requires original Gateway authority"
        : "cannot use this model",
    );
    expect(host.call).not.toHaveBeenCalled();
    await expectOk(host.sdk());
    expect(host.call).toHaveBeenCalledOnce();
    expect(host.call.mock.calls[0]?.[1].model).toBe(model);
  },
);
it("leaves disabled and unconfigured evaluations network-free", async () => {
  const host = fixture();
  await expectUnavailable(host.run({}, {}), "disabled");
  await expectUnavailable(
    evaluateDecisionInRegistry(batch, options(), null, config),
    "not-configured",
  );
  expect(host.call).not.toHaveBeenCalled();
});
it.each([
  { state: "unconfirmed", isReady: undefined, credentialReady: false, callable: true },
  { state: "ready", isReady: () => true, credentialReady: true, callable: true },
  { state: "unavailable", isReady: () => false, credentialReady: false, callable: false },
])(
  "reports $state readiness without confusing credential evidence with admission",
  async ({ isReady, credentialReady, callable }) => {
    const host = fixture(undefined, isReady);
    expect(host.inspect()).toMatchObject({ credentialReady, callable });
    if (callable) {
      await expectOk(host.run());
      expect(host.call).toHaveBeenCalledOnce();
    } else {
      await expectUnavailable(host.run(), "credentials-unavailable");
      expect(host.call).not.toHaveBeenCalled();
    }
    expect(host.inspect()).toMatchObject({ credentialReady, callable });
    host.provider.retire();
    expect(host.inspect()).toMatchObject({ credentialReady: false, callable: false });
    await expectUnavailable(host.run(), "retiring");
  },
);
it("fences a changed agent selection without retiring another agent's concurrent request", async () => {
  const releases = new Map<string, () => void>();
  const started = createDeferredCore();
  const host = fixture(async (_batch, { agentId }) => {
    await new Promise<void>((resolve) => {
      releases.set(agentId!, resolve);
      if (releases.size === 2) {
        started.resolve();
      }
    });
    return answer;
  });
  const selected = modelConfig(undefined, {
    first: "fixture/first-v1",
    second: "fixture/second-v1",
  });
  setRuntimeConfigSnapshot(selected);
  const first = host.run({ agentId: "first" }, selected);
  const second = host.run({ agentId: "second" }, selected);
  await started.promise;
  const next = structuredClone(selected);
  next.agents!.entries!.first!.decisionModel = "fixture/first-v2";
  setRuntimeConfigSnapshot(next);
  const generation = host.inspect(next).runtimeGeneration;
  for (const release of releases.values()) {
    release();
  }
  await expectUnavailable(first, "retiring");
  expect(await second).toMatchObject({
    status: "ok",
    provenance: { runtimeGeneration: generation },
  });
  expect(host.inspect(next)).toMatchObject({ successCount: 1, activeRequests: 0 });
});
it("propagates caller cancellation without fallback classification", async () => {
  const caller = new AbortController();
  const host = fixture(async (_batch, { signal }) => {
    await waitForAbort(signal);
    return answer;
  });
  const pending = host.run({ signal: caller.signal });
  await host.started;
  caller.abort(new Error("source replaced"));
  await expect(pending).rejects.toThrow("source replaced");
});
it.each([
  { consumerId: "consumer", changed: ["owner", "consumer"], consumerRetired: true },
  { consumerId: "consumer", changed: ["owner"], consumerRetired: false },
])(
  "preserves consumer retirement when $consumerId calls a replaced provider ($changed)",
  async ({ consumerId, changed, consumerRetired }) => {
    let settled = false;
    const host = fixture(async (_batch, { signal }) => {
      await waitForAbort(signal);
      settled = true;
      signal.throwIfAborted();
      return answer;
    });
    const pending = host.run({}, config, batch, consumerId);
    await host.started;
    host.reload(changed);
    if (consumerRetired) {
      await expect(pending).rejects.toThrow("Decision consumer authority closed.");
    } else {
      await expectUnavailable(pending, "retiring");
    }
    expect(settled).toBe(true);
  },
);
it("closes provider admission before notifying retiring consumers", async () => {
  let reentered: ReturnType<typeof evaluateDecisionInRegistry> | undefined;
  let calls = 0;
  const host = fixture(async (_batch, { signal }) => {
    calls++;
    if (calls > 1) {
      return answer;
    }
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          reentered = host.run();
          resolve();
        },
        { once: true },
      );
    });
    signal.throwIfAborted();
    return answer;
  });
  const pending = host.run({}, config, batch, "owner");
  await host.started;
  host.reload();
  await expect(pending).rejects.toThrow("Decision consumer authority closed.");
  expect(await reentered).toMatchObject({ status: "unavailable", reason: "retiring" });
  expect(calls).toBe(1);
});
it("distinguishes caller defects from resource limits without network", async () => {
  const host = fixture();
  await expect(host.run({}, config, { state: "", questions: {} })).rejects.toThrow(
    "Invalid decision contract",
  );
  await expectUnavailable(
    host.run({}, config, { ...batch, state: "x".repeat(1_048_577) }),
    "unsupported-input",
  );
  expect(host.call).not.toHaveBeenCalled();
});
it("requires exact answer IDs, bounded rubric positions and usable probabilities", () => {
  expect(validateDecisionBatch(batch)).toBe(true);
  expect(validateDecisionResult(batch, answer.result)).toBe(true);
  const invalidAnswers = [
    { extra: { type: "boolean", probabilityTrue: 1 } },
    { rank: { ...answer.result.answers.rank, score: 2.1 } },
    ...[
      { yes: 0, unclear: 0 },
      { yes: -0.1, unclear: 1 },
      { yes: 0, unclear: 1.1 },
      { yes: Number.NaN, unclear: 1 },
      { yes: 1 },
    ].map((probabilities) => ({ pick: { ...answer.result.answers.pick, probabilities } })),
  ];
  for (const patch of invalidAnswers) {
    const result = { ...answer.result, answers: { ...answer.result.answers, ...patch } };
    expect(validateDecisionResult(batch, result)).toBe(false);
  }
});
it.each([
  { settlement: "resolve", failureReason: "transport" },
  { settlement: "reject", failureReason: "rate-limited" },
] as const)(
  "keeps $settlement caller deadlines out of shared health while preserving $failureReason accounting",
  async ({ settlement, failureReason }) => {
    setRuntimeConfigSnapshot(config);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const deadlineStarted = Array.from({ length: 3 }, () => createDeferredCore());
      let attempt = 0;
      const host = fixture(async (_batch, { signal }) => {
        const current = attempt++;
        if (current < deadlineStarted.length) {
          deadlineStarted[current]!.resolve();
          await waitForAbort(signal);
          if (settlement === "reject") {
            throw new Error("provider abort detail");
          }
        }
        return answer;
      });

      for (let index = 0; index < deadlineStarted.length; index++) {
        const pending = host.run({
          purpose: "tool-prefilter.semantic-gate",
          timeoutMs: 500,
        });
        await deadlineStarted[index]!.promise;
        expect(host.inspect().activeRequests).toBe(1);
        await vi.advanceTimersByTimeAsync(500);
        await expectUnavailable(pending, "deadline");
        expect(host.inspect()).toMatchObject({
          activeRequests: 0,
          callable: true,
          reasons: { deadline: index + 1 },
        });
      }

      const explicit = await createDecisionTool("main", { config })!.execute(
        "after-optional-deadlines",
        batch,
        options().signal,
      );
      expect(explicit.details).toMatchObject({ status: "ok" });
      expect(host.call).toHaveBeenCalledTimes(4);
      expect(host.inspect()).toMatchObject({
        activeRequests: 0,
        callable: true,
        successCount: 1,
        reasons: { deadline: 3 },
      });

      host.call.mockResolvedValue({ status: "unavailable", reason: failureReason });
      for (let index = 1; index <= 3; index++) {
        await expectUnavailable(host.run({ purpose: "decision_evaluate" }), failureReason);
        expect(host.call).toHaveBeenCalledTimes(4 + index);
      }
      await expectUnavailable(host.run({ purpose: "decision_evaluate" }), "circuit-open");
      expect(host.call).toHaveBeenCalledTimes(7);
      expect(host.inspect()).toMatchObject({
        activeRequests: 0,
        callable: false,
        reasons: { deadline: 3, [failureReason]: 3, "circuit-open": 1 },
      });
    } finally {
      vi.useRealTimers();
    }
  },
);
it("bounds recovery to one half-open trial", async () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const host = fixture(async () => ({ status: "unavailable", reason: "transport" }));
  try {
    for (let i = 0; i < 3; i++) {
      await host.run();
    }
    now = 10_001;
    const release = createDeferredCore();
    const trialStarted = createDeferredCore();
    host.call.mockImplementation(async () => {
      trialStarted.resolve();
      await release.promise;
      return answer;
    });
    const trial = host.run();
    await trialStarted.promise;
    const duringTrial = host.inspect();
    expect(await host.run()).toMatchObject({ reason: "circuit-open" });
    release.resolve();
    await expectOk(trial);
    expect(duringTrial).toMatchObject({ callable: false, activeRequests: 1 });
    expect(host.inspect().callable).toBe(true);
    expect(host.call).toHaveBeenCalledTimes(4);
  } finally {
    clock.mockRestore();
  }
});
it.each([
  "input getter",
  "input sparse",
  "input symbol",
  "output inherited serialization",
  "output hidden",
])("rejects %s before publishing an incomplete clone", async (variant) => {
  const sideEffect = vi.fn(() => {
    throw new Error("private detail");
  });
  const submitted = { ...structuredClone(batch) };
  const returned = structuredClone(answer);
  if (variant.endsWith("inherited serialization")) {
    const prototype = { toJSON: sideEffect };
    Object.setPrototypeOf(prototype, Array.prototype);
    Object.setPrototypeOf(returned.result.answers.rank.probabilities, prototype);
  } else if (variant === "input getter") {
    submitted.state = Object.defineProperty({}, "field", { get: sideEffect, enumerable: true });
  } else if (variant === "input sparse") {
    const sparse: string[] = [];
    sparse.length = 2;
    submitted.state = null;
    submitted.questions = { q: { type: "score", criteria: sparse } };
  } else if (variant === "input symbol") {
    submitted.state = Object.assign({}, { [Symbol("unsupported")]: "hidden" });
  } else {
    Object.defineProperty(returned.result, "model", { enumerable: false });
  }
  const host = fixture(async () => returned);
  const pending = host.run({}, config, submitted);
  if (variant.startsWith("input")) {
    await expect(pending).rejects.toThrow("Invalid decision contract");
    expect(host.call).not.toHaveBeenCalled();
  } else {
    await expectUnavailable(pending, "invalid-response");
  }
  expect(sideEffect).not.toHaveBeenCalled();
});

it.each(["readiness", "evaluate", "outcome"])(
  "sanitizes private provider defects in %s",
  async (stage) => {
    const fail = () => {
      throw new Error("private provider detail");
    };
    const host = fixture(
      async () => {
        if (stage === "evaluate") {
          fail();
        }
        return stage === "outcome"
          ? Object.defineProperty(structuredClone(answer), "status", { get: fail })
          : answer;
      },
      stage === "readiness" ? fail : undefined,
    );
    await expect(host.run()).rejects.toThrow("Invalid decision contract");
  },
);
it("uses an admitted snapshot even if caller or provider mutates its input", async () => {
  const release = createDeferredCore();
  const host = fixture(async (input) => {
    expect(input.state).toEqual({ evidence: "synthetic" });
    Reflect.deleteProperty(input.questions, "pick");
    await release.promise;
    expect(input.state).toEqual({ evidence: "synthetic" });
    return answer;
  });
  const submitted = { ...structuredClone(batch), state: { evidence: "synthetic" } };
  const pending = host.run({}, config, submitted);
  expect(Object.hasOwn(submitted.questions, "pick")).toBe(true);
  submitted.state.evidence = "caller mutation";
  Reflect.deleteProperty(submitted.questions, "rank");
  await host.started;
  release.resolve();
  await expectOk(pending);
});
it("leaves a timed-out rollback fenced after late physical settlement", async () => {
  vi.useFakeTimers();
  const host = blockedFixture();
  const pending = host.run();
  await host.started;
  try {
    const replacement = host.reload();
    const rollback = replacement.rollback(new AbortController().signal);
    const rejected = expect(rollback).rejects.toThrow("plugin host cleanup timed out");
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(await host.run()).toMatchObject({ reason: "retiring" });
    host.release();
    expect(await pending).toMatchObject({ reason: "retiring" });
    expect(await host.run()).toMatchObject({ reason: "retiring" });
    expect(host.inspect().activeRequests).toBe(0);
  } finally {
    host.release();
    await pending;
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "settles a provider callback before disposal cleanup waits on its host (sibling: %s)",
  async (withSibling) => {
    const siblingRelease = createDeferredCore();
    const host = blockedFixture();
    const sibling = withSibling ? host.instance.run(() => siblingRelease.promise) : undefined;
    const pending = host.run();
    await host.started;

    const disposal = host.instance.dispose();
    host.release();
    try {
      // Another admitted call can postpone host.stop(), but cannot keep this
      // retiring instance's completed provider result current.
      await expectUnavailable(pending, "retiring");
    } finally {
      siblingRelease.resolve();
      await sibling;
      await disposal;
    }
    await expect(disposal).resolves.toEqual({ errors: [] });
    expect(host.inspect().activeRequests).toBe(0);
  },
);

it.each(["stop", "superseded", "canceled"] as const)(
  "does not reopen rollback after %s",
  async (boundary) => {
    const host = fixture();
    const replacement = host.reload();
    const signal = new AbortController();
    if (boundary === "stop") {
      await host.provider.stop();
    } else if (boundary === "superseded") {
      host.reload();
    } else {
      signal.abort(new Error("recovery canceled"));
    }
    await expect(replacement.rollback(signal.signal)).rejects.toThrow();
    expect(await host.run()).toMatchObject({ reason: "retiring" });
  },
);

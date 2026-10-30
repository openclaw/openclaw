import { AsyncResource } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
import { waitForAbort } from "./contract.test-support.js";
import { evaluateDecisionInRegistry, prepareDecisionProviderReload } from "./runtime.js";
import { answer, batch, config, options, registered } from "./runtime.test-support.js";
import type { DecisionProviderV1 } from "./types.js";
import { validateDecisionBatch, validateDecisionResult } from "./validation.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

type Host = ReturnType<typeof registered>;
type LlmPolicy = NonNullable<NonNullable<OpenClawConfig["plugins"]>["entries"]>[string]["llm"];
const spyHost = (isReady?: () => boolean, providerId?: string) => {
  const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
  return { ...registered(evaluate, isReady, providerId), evaluate };
};
const inspect = (host: Host, cfg = config) => host.registry.decisionProviders[0]!.host.inspect(cfg);
const expectState = (host: Host, state: Partial<ReturnType<typeof inspect>>, cfg = config) => {
  expect(inspect(host, cfg)).toMatchObject(state);
};
const reload = (host: Host, changed = [host.record.id]) =>
  prepareDecisionProviderReload(host.registry, new Set(changed));
const policyConfig = (llm: LlmPolicy, agents = config.agents): OpenClawConfig => ({
  agents,
  plugins: { entries: { owner: { llm } } },
});
const sdk = (host: Host, overrides: Partial<ReturnType<typeof options>> = {}) =>
  host.api.runtime.decisions.evaluate(batch, { ...options(), ...overrides });
const expectOk = async (pending: Promise<unknown>) => {
  expect(await pending).toMatchObject({ status: "ok" });
};
const expectUnavailable = async (pending: Promise<unknown>, reason: string) => {
  expect(await pending).toEqual({ status: "unavailable", reason });
};

describe("registered decision capability", () => {
  it.each([
    ["specialist", ["fixture/other"], "not allowlisted"],
    [undefined, ["fixture/other"], "not allowlisted"],
    [undefined, [], "no valid models"],
    [undefined, ["invalid"], "no valid models"],
  ] as const)("denies SDK policy before dispatch: %s %j %s", async (agentId, models, reason) => {
    const { evaluate, ...host } = spyHost();
    setRuntimeConfigSnapshot(policyConfig({ allowedCompletionModels: [...models] }));
    await expect(sdk(host, { agentId })).rejects.toThrow(reason);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([undefined, ["fixture/fixture-v1"], ["*"]])(
    "keeps global role selection independent of override-only policy (%j)",
    async (allowedCompletionModels) => {
      const { evaluate, ...host } = spyHost();
      setRuntimeConfigSnapshot(
        policyConfig(
          { allowModelOverride: false, allowedModels: [], allowedCompletionModels },
          {
            defaults: {
              decisionModel: "fixture/fixture-v1",
              modelPolicy: { allow: ["fixture/conversation-only"] },
            },
            entries: { main: { decisionModel: "fixture/main-role" } },
          },
        ),
      );
      await expectOk(
        withGatewayToolCallerIdentity({ agentId: "main", sessionKey: "agent:main:fixture" }, () =>
          sdk(host),
        ),
      );
      expect(evaluate).toHaveBeenCalledOnce();
      expect(evaluate.mock.calls[0]?.[1]).toMatchObject({ model: "fixture-v1" });
      expect(evaluate.mock.calls[0]?.[1].agentId).toBeUndefined();
    },
  );

  it.each([undefined, false, true])(
    "preserves owner-agent SDK calls without requiring override permission (%j)",
    async (allowAgentIdOverride) => {
      const { evaluate, ...host } = spyHost();
      setRuntimeConfigSnapshot(
        policyConfig(
          { allowAgentIdOverride, allowedCompletionModels: ["fixture/specialist-v1"] },
          {
            defaults: { model: "fixture/primary" },
            entries: {
              specialist: { decisionModel: "fixture/specialist-v1" },
              disabled: { decisionModel: "" },
            },
          },
        ),
      );
      await expectOk(
        withGatewayToolCallerIdentity(
          { agentId: "specialist", sessionKey: "agent:specialist:fixture" },
          () => sdk(host, { agentId: "specialist" }),
        ),
      );
      expect(evaluate.mock.calls[0]?.[1]).toMatchObject({
        model: "specialist-v1",
        agentId: "specialist",
      });
      for (const agentId of [undefined, "disabled"]) {
        await expectUnavailable(sdk(host, { agentId }), "disabled");
      }
      expect(evaluate).toHaveBeenCalledOnce();
    },
  );

  it.each(["consumer", "MixedConsumer"])(
    "uses registered consumer %s policy, not provider, ambient plugin or option identity",
    async (consumerId) => {
      const { evaluate, ...host } = spyHost();
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
      expect(evaluate).not.toHaveBeenCalled();
      // Provider configuration is not consumer authorization either.
      await expectOk(sdk(host));
    },
  );

  it("routes a configured custom TypeSafe model without requiring a catalog preset", async () => {
    const { evaluate, ...host } = spyHost(undefined, "typesafe");
    await expectOk(
      host.run(options(), {
        agents: { defaults: { decisionModel: "typesafe/nemotron-deciffusion" } },
      }),
    );
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[1].model).toBe("nemotron-deciffusion");
  });
  it("uses the adopted owner from a collected callback scope without reviving a retired instance", async () => {
    class RetiredRegistry {
      readonly fixtureLabel = "RetiredRegistry";
    }
    const { evaluate, ...host } = spyHost();
    const instance = getPluginInstance(host.record)!;
    setRuntimeConfigSnapshot(config);
    const current = { ...host.registry };
    const resource = (() => {
      const previous = Object.assign(new RetiredRegistry(), host.registry);
      markPluginRegistryActive(previous);
      const retained = instance.run(() => new AsyncResource("retired-decision-scope"));
      markPluginRegistryActive(current);
      markPluginRegistryRetired(previous);
      return retained;
    })();
    try {
      await setImmediate();
      expect(queryObjects(RetiredRegistry)).toBe(0);
      const invoke = () => resource.runInAsyncScope(() => sdk(host));
      await expectOk(invoke());
      expect(evaluate).toHaveBeenCalledOnce();
      revokePluginRecord(current, host.record);
      await expect(invoke()).rejects.toThrow("runtime is no longer active");
      expect(evaluate).toHaveBeenCalledOnce();
    } finally {
      resource.emitDestroy();
      markPluginRegistryRetired(current);
    }
  });

  it("keeps ordinary input rejection recoverable without retries or circuit poisoning", async () => {
    const call = vi.fn<DecisionProviderV1["evaluate"]>(async () => ({
      status: "unavailable",
      reason: "unsupported-input",
      retryAfterMs: 60_000,
    }));
    const host = registered(call);
    setRuntimeConfigSnapshot(config);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await expectUnavailable(sdk(host), "unsupported-input");
      expect(call).toHaveBeenCalledTimes(attempt);
    }
    call.mockResolvedValueOnce(answer);
    await expectOk(sdk(host));
    expect(call).toHaveBeenCalledTimes(5);
    expect(inspect(host).callable).toBe(true);
  });

  it("reuses the validated provider snapshots for safe usage, diagnostics and outcomes", async () => {
    let resultReads = 0;
    let reasonReads = 0;
    const call = vi.fn<DecisionProviderV1["evaluate"]>(async () =>
      Object.defineProperty({ status: "ok", result: answer.result }, "result", {
        get: () =>
          ++resultReads === 1 ? answer.result : { usage: { inputTokens: "private-provider-body" } },
      }),
    );
    const host = registered(call);
    expect(await host.run()).toMatchObject({
      ...answer,
      provenance: { providerId: "fixture", rubricVersion: "1" },
    });
    expect(resultReads).toBe(1);
    call.mockImplementationOnce(async () =>
      Object.defineProperty({ status: "unavailable", reason: "unsupported-input" }, "reason", {
        get: () => (++reasonReads === 1 ? "unsupported-input" : "private-provider-body"),
      }),
    );
    await expectUnavailable(host.run(), "unsupported-input");
    expect(reasonReads).toBe(1);
  });

  it("requires a current Gateway binding for scoped operator decisions", async () => {
    const { evaluate, ...host } = spyHost();
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
        () => sdk(host),
      ),
    ).rejects.toThrow("Decision evaluation requires its current Gateway binding.");
    expect(evaluate).not.toHaveBeenCalled();
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
      const { evaluate, ...host } = spyHost();
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
      const selected: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: { model: "fixture/permitted", decisionModel: `fixture/${model}` },
        },
      };
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
      const invoke = () => sdk(host);
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
      expect(evaluate).not.toHaveBeenCalled();
      await expectOk(sdk(host));
      expect(evaluate).toHaveBeenCalledOnce();
      expect(evaluate.mock.calls[0]?.[1].model).toBe(model);
    },
  );
  it("leaves disabled and unconfigured evaluations network-free", async () => {
    const { evaluate: call, ...host } = spyHost();
    await expectUnavailable(host.run(options(), {}), "disabled");
    await expectUnavailable(
      evaluateDecisionInRegistry(batch, options(), null, config),
      "not-configured",
    );
    expect(call).not.toHaveBeenCalled();
  });
  it.each([
    { state: "unconfirmed", isReady: undefined, credentialReady: false, callable: true },
    { state: "ready", isReady: () => true, credentialReady: true, callable: true },
    { state: "unavailable", isReady: () => false, credentialReady: false, callable: false },
  ])(
    "reports $state readiness without confusing credential evidence with admission",
    async ({ isReady, credentialReady, callable }) => {
      const { evaluate: call, ...host } = spyHost(isReady);
      expectState(host, { credentialReady, callable });
      if (callable) {
        await expectOk(host.run());
        expect(call).toHaveBeenCalledOnce();
      } else {
        await expectUnavailable(host.run(), "credentials-unavailable");
        expect(call).not.toHaveBeenCalled();
      }
      expectState(host, { credentialReady, callable });
      host.registry.decisionProviders[0]!.host.retire();
      expectState(host, { credentialReady: false, callable: false });
      await expectUnavailable(host.run(), "retiring");
    },
  );
  it("fences a changed agent selection without retiring another agent's concurrent request", async () => {
    const releases = new Map<string, () => void>();
    const started = createDeferredCore();
    const host = registered(async (_batch, { agentId }) => {
      await new Promise<void>((resolve) => {
        releases.set(agentId!, resolve);
        if (releases.size === 2) {
          started.resolve();
        }
      });
      return answer;
    });
    const selected: OpenClawConfig = {
      agents: {
        entries: {
          first: { decisionModel: "fixture/first-v1" },
          second: { decisionModel: "fixture/second-v1" },
        },
      },
    };
    setRuntimeConfigSnapshot(selected);
    const first = host.run({ ...options(), agentId: "first" }, selected);
    const second = host.run({ ...options(), agentId: "second" }, selected);
    await started.promise;
    const next = structuredClone(selected);
    next.agents!.entries!.first!.decisionModel = "fixture/first-v2";
    setRuntimeConfigSnapshot(next);
    const generation = inspect(host, next).runtimeGeneration;
    for (const release of releases.values()) {
      release();
    }
    await expectUnavailable(first, "retiring");
    expect(await second).toMatchObject({
      status: "ok",
      provenance: { runtimeGeneration: generation },
    });
    expectState(host, { successCount: 1, activeRequests: 0 }, next);
  });
  it("propagates caller cancellation without fallback classification", async () => {
    const caller = new AbortController();
    const host = registered(async (_batch, { signal }) => {
      await waitForAbort(signal);
      return answer;
    });
    const pending = host.run({ ...options(), signal: caller.signal });
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
      const host = registered(async (_batch, { signal }) => {
        await waitForAbort(signal);
        settled = true;
        signal.throwIfAborted();
        return answer;
      });
      const pending = evaluateDecisionInRegistry(
        batch,
        options(),
        host.registry,
        config,
        consumerId,
      );
      await host.started;
      reload(host, changed);
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
    const host = registered(async (_batch, { signal }) => {
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
    const pending = evaluateDecisionInRegistry(batch, options(), host.registry, config, "owner");
    await host.started;
    reload(host);
    await expect(pending).rejects.toThrow("Decision consumer authority closed.");
    expect(await reentered).toMatchObject({ status: "unavailable", reason: "retiring" });
    expect(calls).toBe(1);
  });
  it("distinguishes caller defects from resource limits without network", async () => {
    const { evaluate: call, ...host } = spyHost();
    await expect(
      evaluateDecisionInRegistry({ state: "", questions: {} }, options(), host.registry, config),
    ).rejects.toThrow("Invalid decision contract");
    await expectUnavailable(
      evaluateDecisionInRegistry(
        { ...batch, state: "x".repeat(1_048_577) },
        options(),
        host.registry,
        config,
      ),
      "unsupported-input",
    );
    expect(call).not.toHaveBeenCalled();
  });
});

describe("numerical contract", () => {
  it("requires exact answer IDs, bounded rubric positions and usable probabilities", () => {
    expect(validateDecisionBatch(batch)).toBe(true);
    expect(validateDecisionResult(batch, answer.result)).toBe(true);
    const invalidAnswers = [
      { ...answer.result.answers, extra: { type: "boolean", probabilityTrue: 1 } },
      {
        ...answer.result.answers,
        rank: { type: "score", score: 2.1, probabilities: [0.1, 0.5, 0.4] },
      },
      ...[
        { yes: 0, unclear: 0 },
        { yes: -0.1, unclear: 1 },
        { yes: 0, unclear: 1.1 },
        { yes: Number.NaN, unclear: 1 },
        { yes: 1 },
      ].map((probabilities) =>
        Object.assign({}, answer.result.answers, {
          pick: { type: "choice", choice: "yes", probabilities },
        }),
      ),
    ];
    for (const answers of invalidAnswers) {
      expect(validateDecisionResult(batch, { ...answer.result, answers })).toBe(false);
    }
  });
});

describe("fault settlement and generation health", () => {
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
        const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async (_batch, { signal }) => {
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
        const host = registered(evaluate);

        for (let index = 0; index < deadlineStarted.length; index++) {
          const pending = host.run({
            ...options(),
            purpose: "tool-prefilter.semantic-gate",
            timeoutMs: 500,
          });
          await deadlineStarted[index]!.promise;
          expect(inspect(host).activeRequests).toBe(1);
          await vi.advanceTimersByTimeAsync(500);
          await expectUnavailable(pending, "deadline");
          expectState(host, {
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
        expect(evaluate).toHaveBeenCalledTimes(4);
        expectState(host, {
          activeRequests: 0,
          callable: true,
          successCount: 1,
          reasons: { deadline: 3 },
        });

        evaluate.mockResolvedValue({ status: "unavailable", reason: failureReason });
        for (let index = 1; index <= 3; index++) {
          await expectUnavailable(
            host.run({ ...options(), purpose: "decision_evaluate" }),
            failureReason,
          );
          expect(evaluate).toHaveBeenCalledTimes(4 + index);
        }
        await expectUnavailable(
          host.run({ ...options(), purpose: "decision_evaluate" }),
          "circuit-open",
        );
        expect(evaluate).toHaveBeenCalledTimes(7);
        expectState(host, {
          activeRequests: 0,
          callable: false,
          reasons: { deadline: 3, [failureReason]: 3, "circuit-open": 1 },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("keeps rejected credentials from blocking another agent or later credential recovery", async () => {
    let firstCredentialAccepted = false;
    const callback = vi.fn<DecisionProviderV1["evaluate"]>(async (_batch, { agentId }) =>
      agentId === "first" && !firstCredentialAccepted
        ? { status: "unavailable", reason: "authentication", retryAfterMs: 60_000 }
        : answer,
    );
    const host = registered(callback);

    for (let attempt = 1; attempt <= 3; attempt++) {
      await expectUnavailable(host.run({ ...options(), agentId: "first" }), "authentication");
      expect(callback).toHaveBeenCalledTimes(attempt);
    }
    await expectOk(host.run({ ...options(), agentId: "second" }));

    firstCredentialAccepted = true;
    await expectOk(host.run({ ...options(), agentId: "first" }));
    expect(callback).toHaveBeenCalledTimes(5);
    expectState(host, {
      activeRequests: 0,
      callable: true,
      successCount: 2,
      reasons: { authentication: 3 },
    });
  });
  it("bounds recovery to one half-open trial", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const release = createDeferredCore();
    const callback = vi
      .fn<DecisionProviderV1["evaluate"]>()
      .mockResolvedValue({ status: "unavailable", reason: "transport" });
    const host = registered(callback);
    try {
      for (let i = 0; i < 3; i++) {
        await host.run();
      }
      now = 10_001;
      const trialStarted = createDeferredCore();
      callback.mockImplementation(async () => {
        trialStarted.resolve();
        await release.promise;
        return answer;
      });
      const trial = host.run();
      await trialStarted.promise;
      const duringTrial = inspect(host);
      expect(await host.run()).toMatchObject({ reason: "circuit-open" });
      release.resolve();
      await expectOk(trial);
      expect(duringTrial).toMatchObject({ callable: false, activeRequests: 1 });
      expect(inspect(host).callable).toBe(true);
      expect(callback).toHaveBeenCalledTimes(4);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("immutable finite JSON boundaries", () => {
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
    const call = vi.fn<DecisionProviderV1["evaluate"]>(async () => returned);
    const host = registered(call);
    const pending = evaluateDecisionInRegistry(submitted, options(), host.registry, config);
    if (variant.startsWith("input")) {
      await expect(pending).rejects.toThrow("Invalid decision contract");
      expect(call).not.toHaveBeenCalled();
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
      const host = registered(
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
    const host = registered(async (input) => {
      expect(input.state).toEqual({ evidence: "synthetic" });
      Reflect.deleteProperty(input.questions, "pick");
      await release.promise;
      expect(input.state).toEqual({ evidence: "synthetic" });
      return answer;
    });
    const submitted = { ...structuredClone(batch), state: { evidence: "synthetic" } };
    const pending = evaluateDecisionInRegistry(submitted, options(), host.registry, config);
    expect(Object.hasOwn(submitted.questions, "pick")).toBe(true);
    submitted.state.evidence = "caller mutation";
    Reflect.deleteProperty(submitted.questions, "rank");
    await host.started;
    release.resolve();
    await expectOk(pending);
  });
});

it("leaves a timed-out rollback fenced after late physical settlement", async () => {
  vi.useFakeTimers();
  const release = createDeferredCore();
  const host = registered(async () => {
    await release.promise;
    return answer;
  });
  const pending = host.run();
  await host.started;
  try {
    const replacement = reload(host);
    const rollback = replacement.rollback(new AbortController().signal);
    const rejected = expect(rollback).rejects.toThrow("plugin host cleanup timed out");
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(await host.run()).toMatchObject({ reason: "retiring" });
    release.resolve();
    expect(await pending).toMatchObject({ reason: "retiring" });
    expect(await host.run()).toMatchObject({ reason: "retiring" });
    expect(inspect(host).activeRequests).toBe(0);
  } finally {
    release.resolve();
    await pending;
    vi.useRealTimers();
  }
});

it.each([false, true])(
  "settles a provider callback before disposal cleanup waits on its host (sibling: %s)",
  async (withSibling) => {
    const started = createDeferredCore();
    const release = createDeferredCore();
    const siblingRelease = createDeferredCore();
    const host = registered(async () => {
      started.resolve();
      await release.promise;
      return answer;
    });
    const instance = getPluginInstance(host.record)!;
    const sibling = withSibling ? instance.run(() => siblingRelease.promise) : undefined;
    const pending = host.run();
    await started.promise;

    const disposal = instance.dispose();
    release.resolve();
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
    expect(inspect(host).activeRequests).toBe(0);
  },
);

it.each(["stop", "superseded", "canceled"] as const)(
  "does not reopen rollback after %s",
  async (boundary) => {
    const host = registered();
    const replacement = reload(host);
    const signal = new AbortController();
    if (boundary === "stop") {
      await host.registry.decisionProviders[0]!.host.stop();
    } else if (boundary === "superseded") {
      reload(host);
    } else {
      signal.abort(new Error("recovery canceled"));
    }
    await expect(replacement.rollback(signal.signal)).rejects.toThrow();
    expect(await host.run()).toMatchObject({ reason: "retiring" });
  },
);

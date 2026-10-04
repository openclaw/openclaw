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
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as diagnostics from "./diagnostics.js";
import { evaluateDecisionInRegistry, prepareDecisionProviderReload } from "./runtime.js";
import { answer, batch, config, options, registered } from "./runtime.test-support.js";
import type { DecisionProviderV1, ProviderDecisionOutcome } from "./types.js";
import { validateDecisionBatch, validateDecisionResult } from "./validation.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

describe("registered decision capability", () => {
  it("keeps ordinary input rejection recoverable without retries or circuit poisoning", async () => {
    const call = vi.fn<DecisionProviderV1["evaluate"]>(async () => ({
      status: "unavailable",
      reason: "unsupported-input",
      retryAfterMs: 60_000,
    }));
    const host = registered(call);
    setRuntimeConfigSnapshot(config);
    const runtime = host.api.runtime.decisions;
    const baseline = ["normal-tool"];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const outcome = await runtime.evaluate(batch, options());
      expect(outcome).toEqual({ status: "unavailable", reason: "unsupported-input" });
      const retained = outcome.status === "unavailable" ? baseline : [];
      expect(retained).toBe(baseline);
      expect(call).toHaveBeenCalledTimes(attempt);
    }
    call.mockResolvedValueOnce(answer);
    expect(await runtime.evaluate(batch, options())).toMatchObject({ status: "ok" });
    expect(call).toHaveBeenCalledTimes(5);
    expect(host.registry.decisionProviders[0]?.host.inspect(config).callable).toBe(true);
  });

  it("does no extra input serialization with DEBUG disabled", async () => {
    const debug = vi.spyOn(diagnostics, "decisionDebugEnabled").mockReturnValue(false);
    const stringify = vi.spyOn(JSON, "stringify");
    onTestFinished(() => {
      debug.mockRestore();
      stringify.mockRestore();
    });
    const host = registered();
    expect(await host.run()).toMatchObject({ status: "ok" });
    // The preexisting host JSON resource guard serializes once; diagnostics add none.
    expect(
      stringify.mock.calls.filter(
        ([value]) =>
          value &&
          typeof value === "object" &&
          Object.hasOwn(value, "state") &&
          Object.hasOwn(value, "questions"),
      ),
    ).toHaveLength(1);
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
    expect(await host.run()).toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(reasonReads).toBe(1);
  });

  it("requires a current Gateway binding for scoped operator decisions", async () => {
    const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
    const host = registered(evaluate);
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
        () => host.api.runtime.decisions.evaluate(batch, options()),
      ),
    ).rejects.toThrow("Decision evaluation requires its current Gateway binding.");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    { model: "fixture-v1", source: "agent-tool" },
    { model: "shortcut", source: "direct-tool" },
    { model: "shortcut", source: "unbound-operator" },
  ] as const)(
    "enforces requester exclusions for $model from $source while preserving independent system decisions",
    async ({ model, source }) => {
      const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
      const host = registered(evaluate);
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
      const invoke = () => host.api.runtime.decisions.evaluate(batch, options());
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
      await expect(host.api.runtime.decisions.evaluate(batch, options())).resolves.toMatchObject({
        status: "ok",
      });
      expect(evaluate).toHaveBeenCalledOnce();
      expect(evaluate.mock.calls[0]?.[1].model).toBe(model);
    },
  );
  it("leaves off, missing and cold credentials network-free", async () => {
    const call = vi.fn(async () => answer);
    const host = registered(call, () => false);
    expect(await host.run()).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
    expect(await evaluateDecisionInRegistry(batch, options(), host.registry, {})).toEqual({
      status: "unavailable",
      reason: "disabled",
    });
    expect(await evaluateDecisionInRegistry(batch, options(), null, config)).toEqual({
      status: "unavailable",
      reason: "not-configured",
    });
    expect(call).not.toHaveBeenCalled();
  });
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
    const generation = host.registry.decisionProviders[0]!.host.inspect(next).runtimeGeneration;
    for (const release of releases.values()) {
      release();
    }
    expect(await first).toEqual({ status: "unavailable", reason: "retiring" });
    expect(await second).toMatchObject({
      status: "ok",
      provenance: { runtimeGeneration: generation },
    });
    expect(host.registry.decisionProviders[0]!.host.inspect(next)).toMatchObject({
      successCount: 1,
      activeRequests: 0,
    });
  });
  it.each([
    { yes: 0.49, unclear: 0.51 },
    { yes: 0.49, unclear: 0.5 },
    { yes: 0.5, unclear: 0.51 },
  ])(
    "preserves provider labels and independently rounded probability estimates: %j",
    async (probabilities) => {
      const independent: ProviderDecisionOutcome = {
        status: "ok",
        result: {
          ...answer.result,
          answers: {
            ...answer.result.answers,
            pick: { type: "choice", choice: "yes", probabilities },
            rank: { type: "score", score: 1.01, probabilities: [0.33, 0.33, 0.33] },
          },
        },
      };
      const host = registered(async () => independent);
      expect(await host.run()).toMatchObject(independent);
    },
  );
  it("propagates caller cancellation without fallback classification", async () => {
    const caller = new AbortController();
    const host = registered(async (_batch, { signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return answer;
    });
    const pending = host.run({ ...options(), signal: caller.signal });
    await host.started;
    caller.abort(new Error("source replaced"));
    await expect(pending).rejects.toThrow("source replaced");
  });
  it.each([
    { consumerId: "owner", changed: ["owner"], consumerRetired: true },
    { consumerId: "consumer", changed: ["owner", "consumer"], consumerRetired: true },
    { consumerId: "consumer", changed: ["owner"], consumerRetired: false },
  ])(
    "preserves consumer retirement when $consumerId calls a replaced provider ($changed)",
    async ({ consumerId, changed, consumerRetired }) => {
      let settled = false;
      const host = registered(async (_batch, { signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
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
      prepareDecisionProviderReload(host.registry, new Set(changed));
      if (consumerRetired) {
        await expect(pending).rejects.toThrow("Decision consumer authority closed.");
      } else {
        expect(await pending).toEqual({ status: "unavailable", reason: "retiring" });
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
    prepareDecisionProviderReload(host.registry, new Set(["owner"]));
    await expect(pending).rejects.toThrow("Decision consumer authority closed.");
    expect(await reentered).toMatchObject({ status: "unavailable", reason: "retiring" });
    expect(calls).toBe(1);
  });
  it("distinguishes caller defects from resource limits without network", async () => {
    const call = vi.fn(async () => answer);
    const host = registered(call);
    await expect(
      evaluateDecisionInRegistry({ state: "", questions: {} }, options(), host.registry, config),
    ).rejects.toThrow("Invalid decision contract");
    expect(
      await evaluateDecisionInRegistry(
        { ...batch, state: "x".repeat(1_048_577) },
        options(),
        host.registry,
        config,
      ),
    ).toEqual({ status: "unavailable", reason: "unsupported-input" });
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
    { timeoutMs: 20_000, deadlineMs: 20_000 },
    { timeoutMs: 60_000, deadlineMs: 30_000 },
  ])(
    "joins a deadline-aborted callback after $deadlineMs ms for a $timeoutMs ms request",
    async ({ timeoutMs, deadlineMs }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      try {
        let settled = false;
        const host = registered(async (_batch, { signal }) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          settled = true;
          return answer;
        });
        const pending = host.run({ ...options(), timeoutMs });
        await host.started;
        await vi.advanceTimersByTimeAsync(deadlineMs - 1);
        expect(settled).toBe(false);
        expect(host.registry.decisionProviders[0]!.host.inspect(config).activeRequests).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toEqual({ status: "unavailable", reason: "deadline" });
        expect(settled).toBe(true);
        expect(host.registry.decisionProviders[0]!.host.inspect(config)).toMatchObject({
          activeRequests: 0,
          successCount: 0,
          reasons: { deadline: 1 },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );
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
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            if (settlement === "reject") {
              throw new Error("provider abort detail");
            }
          }
          return answer;
        });
        const host = registered(evaluate);
        const providerHost = host.registry.decisionProviders[0]!.host;

        for (let index = 0; index < deadlineStarted.length; index++) {
          const pending = host.run({
            ...options(),
            purpose: "tool-prefilter.semantic-gate",
            timeoutMs: 500,
          });
          await deadlineStarted[index]!.promise;
          expect(providerHost.inspect(config).activeRequests).toBe(1);
          await vi.advanceTimersByTimeAsync(500);
          expect(await pending).toEqual({ status: "unavailable", reason: "deadline" });
          expect(providerHost.inspect(config)).toMatchObject({
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
        expect(providerHost.inspect(config)).toMatchObject({
          activeRequests: 0,
          callable: true,
          successCount: 1,
          reasons: { deadline: 3 },
        });

        evaluate.mockResolvedValue({ status: "unavailable", reason: failureReason });
        for (let index = 1; index <= 3; index++) {
          expect(await host.run({ ...options(), purpose: "decision_evaluate" })).toEqual({
            status: "unavailable",
            reason: failureReason,
          });
          expect(evaluate).toHaveBeenCalledTimes(4 + index);
        }
        expect(await host.run({ ...options(), purpose: "decision_evaluate" })).toEqual({
          status: "unavailable",
          reason: "circuit-open",
        });
        expect(evaluate).toHaveBeenCalledTimes(7);
        expect(providerHost.inspect(config)).toMatchObject({
          activeRequests: 0,
          callable: false,
          reasons: { deadline: 3, [failureReason]: 3, "circuit-open": 1 },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each(["model selection", "admission rollback"])(
    "keeps auth failures across %s until provider configuration changes",
    async (recovery) => {
      const callback = vi
        .fn<DecisionProviderV1["evaluate"]>()
        .mockResolvedValueOnce({ status: "unavailable", reason: "authentication" })
        .mockResolvedValue(answer);
      const host = registered(callback);
      expect(await host.run()).toMatchObject({ reason: "authentication" });
      expect(await host.run()).toMatchObject({ reason: "circuit-open" });
      const selected =
        recovery === "model selection"
          ? { agents: { defaults: { decisionModel: "fixture/another-v1" } } }
          : config;
      if (recovery === "admission rollback") {
        const replacement = prepareDecisionProviderReload(host.registry, new Set([host.record.id]));
        await replacement.rollback(new AbortController().signal);
      }
      expect(await host.run(options(), selected)).toMatchObject({ reason: "circuit-open" });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(
        await host.run(options(), {
          ...selected,
          plugins: { entries: { owner: { config: { endpoint: "updated" } } } },
        }),
      ).toMatchObject({ status: "ok" });
    },
  );
  it("bounds recovery to one half-open trial", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    let finish!: () => void;
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
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return answer;
      });
      const trial = host.run();
      await trialStarted.promise;
      const duringTrial = host.registry.decisionProviders[0]!.host.inspect(config);
      expect(await host.run()).toMatchObject({ reason: "circuit-open" });
      finish();
      expect(await trial).toMatchObject({ status: "ok" });
      expect(duringTrial).toMatchObject({ callable: false, activeRequests: 1 });
      expect(host.registry.decisionProviders[0]!.host.inspect(config).callable).toBe(true);
      expect(callback).toHaveBeenCalledTimes(4);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("immutable finite JSON boundaries", () => {
  it.each([
    "input getter",
    "input hidden",
    "input sparse",
    "input symbol",
    "input inherited serialization",
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
      if (variant.startsWith("input")) {
        submitted.state = Object.setPrototypeOf(["\u0000".repeat(200_000)], prototype);
      } else {
        Object.setPrototypeOf(returned.result.answers.rank.probabilities, prototype);
      }
    } else if (variant === "input getter") {
      submitted.state = Object.defineProperty({}, "field", { get: sideEffect, enumerable: true });
    } else if (variant === "input hidden") {
      submitted.state = Object.defineProperty({}, "evidence", { value: "required evidence" });
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
      await expect(pending).resolves.toEqual({ status: "unavailable", reason: "invalid-response" });
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
    let finish!: () => void;
    const host = registered(async (input) => {
      expect(input.state).toEqual({ evidence: "synthetic" });
      Reflect.deleteProperty(input.questions, "pick");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      expect(input.state).toEqual({ evidence: "synthetic" });
      return answer;
    });
    const submitted = { ...structuredClone(batch), state: { evidence: "synthetic" } };
    const pending = evaluateDecisionInRegistry(submitted, options(), host.registry, config);
    expect(Object.hasOwn(submitted.questions, "pick")).toBe(true);
    submitted.state.evidence = "caller mutation";
    Reflect.deleteProperty(submitted.questions, "rank");
    await host.started;
    finish();
    expect(await pending).toMatchObject({ status: "ok" });
  });
});

it("leaves a timed-out rollback fenced after late physical settlement", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const host = registered(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return answer;
  });
  const pending = host.run();
  await host.started;
  try {
    const replacement = prepareDecisionProviderReload(host.registry, new Set([host.record.id]));
    const rollback = replacement.rollback(new AbortController().signal);
    const rejected = expect(rollback).rejects.toThrow("plugin host cleanup timed out");
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(await host.run()).toMatchObject({ reason: "retiring" });
    release();
    expect(await pending).toMatchObject({ reason: "retiring" });
    expect(await host.run()).toMatchObject({ reason: "retiring" });
    expect(host.registry.decisionProviders[0]!.host.inspect(config).activeRequests).toBe(0);
  } finally {
    release();
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
      await expect(pending).resolves.toEqual({ status: "unavailable", reason: "retiring" });
    } finally {
      siblingRelease.resolve();
      await sibling;
      await disposal;
    }
    await expect(disposal).resolves.toEqual({ errors: [] });
    expect(host.registry.decisionProviders[0]!.host.inspect(config).activeRequests).toBe(0);
  },
);

it.each(["stop", "superseded", "canceled"] as const)(
  "does not reopen rollback after %s",
  async (boundary) => {
    const host = registered();
    const replacement = prepareDecisionProviderReload(host.registry, new Set([host.record.id]));
    const signal = new AbortController();
    if (boundary === "stop") {
      await host.registry.decisionProviders[0]!.host.stop();
    } else if (boundary === "superseded") {
      prepareDecisionProviderReload(host.registry, new Set([host.record.id]));
    } else {
      signal.abort(new Error("recovery canceled"));
    }
    await expect(replacement.rollback(signal.signal)).rejects.toThrow();
    expect(await host.run()).toMatchObject({ reason: "retiring" });
  },
);

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasFinalToolInputPolicies,
  runFinalToolInputPolicies,
} from "./final-tool-input-policy.js";
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext } from "./hook-types.js";
import type { PluginFinalToolInputPolicyRegistration } from "./host-hooks.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const getPluginSessionExtensionStateSyncMock = vi.hoisted(() =>
  vi.fn(({ pluginId }: { pluginId: string }) => ({
    policy: { owner: pluginId },
  })),
);

vi.mock("./host-hook-state.js", () => ({
  getPluginSessionExtensionStateSync: getPluginSessionExtensionStateSyncMock,
}));

function createPolicyRegistry(
  policies: Array<{
    pluginId: string;
    pluginName?: string;
    policy: PluginFinalToolInputPolicyRegistration;
  }>,
) {
  const registry = createEmptyPluginRegistry();
  registry.finalToolInputPolicies = policies.map((entry) => ({
    ...entry,
    source: "test",
  }));
  return registry;
}

const baseContext: PluginHookToolContext = {
  agentId: "main",
  sessionKey: "agent:main:main",
  runId: "run-1",
  toolName: "database_execute",
  toolCallId: "tool-call-1",
};

function createEvent(
  params: Record<string, unknown> = { environment: "production", mode: "write" },
): PluginHookBeforeToolCallEvent {
  return {
    toolName: "database_execute",
    toolCallId: "tool-call-1",
    runId: "run-1",
    params,
    derivedPaths: ["/srv/data/database.sqlite"],
  };
}

afterEach(() => {
  vi.useRealTimers();
  getPluginSessionExtensionStateSyncMock.mockClear();
});

describe("final tool-input policy runner", () => {
  it("runs ordered detached snapshots and seals canonical final params in place", async () => {
    const finalParams = {
      environment: "production",
      nested: { mode: "write" },
    };
    const originalNested = finalParams.nested;
    const policyEvent = createEvent(finalParams);
    const observed: unknown[] = [];
    const registry = createPolicyRegistry([
      {
        pluginId: "snapshot-policy",
        policy: {
          id: "snapshot",
          description: "mutates only its detached view",
          evaluate(event, ctx) {
            expect(Object.isFrozen(event)).toBe(true);
            expect(Object.isFrozen(ctx)).toBe(true);
            (event.params.nested as { mode: string }).mode = "read";
            observed.push(event.params);
            return { outcome: "pass" };
          },
        },
      },
      {
        pluginId: "decision-policy",
        policy: {
          id: "decision",
          description: "inspects an independent snapshot",
          evaluate(event) {
            observed.push(event.params);
            return { outcome: "deny", reasonCode: "production.write_requires_workflow" };
          },
        },
      },
    ]);

    const result = await runFinalToolInputPolicies(policyEvent, baseContext, { registry });

    expect(result).toEqual({
      block: true,
      blockReason: "Tool call blocked by final input policy",
      kind: "deny",
      pluginId: "decision-policy",
      policyId: "decision",
      reasonCode: "production.write_requires_workflow",
    });
    expect(observed).toEqual([
      { environment: "production", nested: { mode: "read" } },
      { environment: "production", nested: { mode: "write" } },
    ]);
    expect(finalParams).toEqual({
      environment: "production",
      nested: { mode: "write" },
    });
    expect(policyEvent.params).toBe(finalParams);
    expect(finalParams.nested).not.toBe(originalNested);
    expect(Object.isFrozen(finalParams)).toBe(true);
    expect(Object.isFrozen(finalParams.nested)).toBe(true);
    expect(Object.isFrozen(originalNested)).toBe(false);
    expect(observed[0]).not.toBe(finalParams);
    expect(observed[1]).not.toBe(finalParams);
  });

  it.each([
    {
      label: "thrown evaluations",
      evaluate: () => {
        throw new Error("private policy failure");
      },
      reasonCode: "policy-evaluation-failed",
    },
    {
      label: "extra pass fields",
      evaluate: () => ({ outcome: "pass", grant: true }) as never,
      reasonCode: "policy-decision-invalid",
    },
    {
      label: "inherited pass outcomes",
      evaluate: () =>
        Object.assign(Object.create({ outcome: "pass" }), { unrelated: true }) as never,
      reasonCode: "policy-decision-invalid",
    },
    {
      label: "class-instance decisions",
      evaluate: () =>
        new (class PolicyDecision {
          outcome = "pass" as const;
        })() as never,
      reasonCode: "policy-decision-invalid",
    },
    {
      label: "hidden extra decision fields",
      evaluate: () => {
        const decision = { outcome: "pass" };
        Object.defineProperty(decision, "hidden", { value: true });
        return decision as never;
      },
      reasonCode: "policy-decision-invalid",
    },
    {
      label: "invalid deny reason codes",
      evaluate: () => ({ outcome: "deny", reasonCode: "Private human prose" }) as never,
      reasonCode: "policy-decision-invalid",
    },
    {
      label: "extra deny fields",
      evaluate: () =>
        ({
          outcome: "deny",
          reasonCode: "production.write_denied",
          detail: "private policy detail",
        }) as never,
      reasonCode: "policy-decision-invalid",
    },
  ])("fails closed for $label", async ({ evaluate, reasonCode }) => {
    const registry = createPolicyRegistry([
      {
        pluginId: "failing-policy",
        policy: {
          id: "failing",
          description: "fails closed",
          evaluate,
        },
      },
    ]);

    const result = await runFinalToolInputPolicies(createEvent(), baseContext, { registry });

    expect(result).toMatchObject({
      block: true,
      blockReason: "Tool call blocked by final input policy",
      kind: "error",
      pluginId: "failing-policy",
      policyId: "failing",
      reasonCode,
    });
    expect(JSON.stringify(result)).not.toContain("private policy failure");
  });

  it("accepts an exact null-prototype pass decision", async () => {
    const registry = createPolicyRegistry([
      {
        pluginId: "null-prototype-policy",
        policy: {
          id: "null-prototype",
          description: "returns an exact null-prototype decision",
          evaluate: () => Object.assign(Object.create(null), { outcome: "pass" }) as never,
        },
      },
    ]);

    await expect(
      runFinalToolInputPolicies(createEvent(), baseContext, { registry }),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      label: "an unreadable registry",
      createRegistry: () => {
        const registry = {};
        Object.defineProperty(registry, "finalToolInputPolicies", {
          enumerable: true,
          get() {
            throw new Error("private registry failure");
          },
        });
        return registry;
      },
    },
    {
      label: "a non-array policy collection",
      createRegistry: () => ({ finalToolInputPolicies: {} }),
    },
  ])("fails closed for $label", async ({ createRegistry }) => {
    const registry = createRegistry();

    expect(hasFinalToolInputPolicies(registry as never)).toBe(true);
    const result = await runFinalToolInputPolicies(createEvent(), baseContext, {
      registry: registry as never,
    });

    expect(result).toMatchObject({
      block: true,
      kind: "error",
      pluginId: "unknown-plugin",
      reasonCode: "policy-unreadable",
    });
    expect(JSON.stringify(result)).not.toContain("private registry failure");
  });

  it.each(["policy", "evaluate", "timeout"] as const)(
    "fails closed when the %s getter is unreadable",
    async (unreadableField) => {
      const evaluate = vi.fn(() => ({ outcome: "pass" as const }));
      const registry = createEmptyPluginRegistry();
      const registration: Record<string, unknown> = {
        pluginId: "getter-policy",
        source: "test",
      };
      if (unreadableField === "policy") {
        Object.defineProperty(registration, "policy", {
          enumerable: true,
          get() {
            throw new Error("private policy getter failure");
          },
        });
      } else {
        const policy: Record<string, unknown> = {
          id: "getter",
          description: `unreadable ${unreadableField}`,
        };
        if (unreadableField === "evaluate") {
          Object.defineProperty(policy, "evaluate", {
            enumerable: true,
            get() {
              throw new Error("private evaluate getter failure");
            },
          });
        } else {
          policy.evaluate = evaluate;
          Object.defineProperty(policy, "timeoutMs", {
            enumerable: true,
            get() {
              throw new Error("private timeout getter failure");
            },
          });
        }
        registration.policy = policy;
      }
      registry.finalToolInputPolicies = [registration as never];

      const result = await runFinalToolInputPolicies(createEvent(), baseContext, { registry });

      expect(result).toMatchObject({
        block: true,
        kind: "error",
        pluginId: "getter-policy",
        reasonCode: "policy-unreadable",
      });
      expect(evaluate).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );

  it("fails closed when policy input cannot be detached", async () => {
    const evaluate = vi.fn(() => ({ outcome: "pass" as const }));
    const registry = createPolicyRegistry([
      {
        pluginId: "clone-policy",
        policy: {
          id: "clone",
          description: "requires detached input",
          evaluate,
        },
      },
    ]);
    const event = createEvent({ callback: () => undefined });

    await expect(
      runFinalToolInputPolicies(event, baseContext, { registry }),
    ).resolves.toMatchObject({
      block: true,
      kind: "error",
      reasonCode: "policy-input-invalid",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed when a policy input getter throws", async () => {
    const evaluate = vi.fn(() => ({ outcome: "pass" as const }));
    const registry = createPolicyRegistry([
      {
        pluginId: "hostile-input-policy",
        policy: {
          id: "hostile-input",
          description: "reject hostile input",
          evaluate,
        },
      },
    ]);
    const params = {};
    Object.defineProperty(params, "secret", {
      enumerable: true,
      get() {
        throw new Error("private hostile input getter");
      },
    });

    const result = await runFinalToolInputPolicies(createEvent(params), baseContext, { registry });

    expect(result).toMatchObject({
      block: true,
      kind: "error",
      reasonCode: "policy-input-invalid",
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private hostile input getter");
  });

  it("rejects enumerable input getters without invoking them", async () => {
    let getterReads = 0;
    const params = {};
    Object.defineProperty(params, "payload", {
      configurable: true,
      enumerable: true,
      get() {
        getterReads += 1;
        return { safe: true };
      },
    });
    const evaluate = vi.fn(() => ({ outcome: "pass" as const }));
    const registry = createPolicyRegistry([
      {
        pluginId: "canonical-snapshot-policy",
        policy: {
          id: "canonical-snapshot",
          description: "inspect a stable canonical snapshot",
          evaluate,
        },
      },
    ]);

    await expect(
      runFinalToolInputPolicies(createEvent(params), baseContext, { registry }),
    ).resolves.toMatchObject({
      block: true,
      kind: "error",
      reasonCode: "policy-input-invalid",
    });
    expect(getterReads).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("rejects a prototype-mutating getter before cloning", async () => {
    const evaluate = vi.fn(() => ({ outcome: "pass" as const }));
    const registry = createPolicyRegistry([
      {
        pluginId: "prototype-stability-policy",
        policy: {
          id: "prototype-stability",
          description: "requires a stable plain root input",
          evaluate,
        },
      },
    ]);
    const params: Record<string, unknown> = {};
    Object.defineProperty(params, "payload", {
      configurable: true,
      enumerable: true,
      get() {
        Object.setPrototypeOf(params, { inherited: "not-data" });
        return { safe: true };
      },
    });

    await expect(
      runFinalToolInputPolicies(createEvent(params), baseContext, { registry }),
    ).resolves.toMatchObject({
      block: true,
      kind: "error",
      reasonCode: "policy-input-invalid",
    });
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed before evaluation when canonical input cannot be sealed", async () => {
    const evaluate = vi.fn(() => ({ outcome: "pass" as const }));
    const registry = createPolicyRegistry([
      {
        pluginId: "unsealable-input-policy",
        policy: {
          id: "unsealable-input",
          description: "requires stable caller input",
          evaluate,
        },
      },
    ]);
    const params = {};
    Object.defineProperty(params, "nested", {
      configurable: false,
      enumerable: true,
      value: { mode: "write" },
      writable: false,
    });

    await expect(
      runFinalToolInputPolicies(createEvent(params), baseContext, { registry }),
    ).resolves.toMatchObject({
      block: true,
      kind: "error",
      reasonCode: "policy-input-seal-failed",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed for SharedArrayBuffer policy input when available", async () => {
    if (typeof SharedArrayBuffer === "undefined") {
      return;
    }
    const evaluate = vi.fn(() => ({ outcome: "pass" as const }));
    const registry = createPolicyRegistry([
      {
        pluginId: "shared-buffer-policy",
        policy: {
          id: "shared-buffer",
          description: "reject shared mutable input",
          evaluate,
        },
      },
    ]);

    const result = await runFinalToolInputPolicies(
      createEvent({ buffer: new SharedArrayBuffer(8) }),
      baseContext,
      { registry },
    );

    expect(result).toMatchObject({
      block: true,
      kind: "error",
      reasonCode: "policy-input-invalid",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "sparse arrays",
      value: Object.assign([] as unknown[], { length: 2 }),
    },
    {
      label: "arrays with custom properties",
      value: Object.assign(["bounded"], { extra: "not-json-array-shape" }),
    },
    {
      label: "arrays with enumerable symbol properties",
      value: (() => {
        const value = ["bounded"];
        Object.defineProperty(value, Symbol("extra"), {
          enumerable: true,
          value: "not-json",
        });
        return value;
      })(),
    },
    {
      label: "array subclasses",
      value: new (class PolicyInputArray extends Array<string> {})("bounded"),
    },
    {
      label: "nested custom-class instances",
      value: new (class PolicyInput {
        readonly marker = "bounded";
      })(),
    },
    {
      label: "oversized objects",
      value: Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`key-${index}`, index])),
    },
    {
      label: "oversized strings",
      value: "x".repeat(64 * 1024 + 1),
    },
    {
      label: "overly deep objects",
      value: (() => {
        let value: Record<string, unknown> = {};
        for (let depth = 0; depth < 34; depth += 1) {
          value = { nested: value };
        }
        return value;
      })(),
    },
  ])("fails closed for $label", async ({ value }) => {
    const evaluate = vi.fn(() => ({ outcome: "pass" as const }));
    const registry = createPolicyRegistry([
      {
        pluginId: "bounded-json-policy",
        policy: {
          id: "bounded-json",
          description: "requires canonical JSON arrays",
          evaluate,
        },
      },
    ]);

    await expect(
      runFinalToolInputPolicies(createEvent({ value }), baseContext, { registry }),
    ).resolves.toMatchObject({
      block: true,
      kind: "error",
      reasonCode: "policy-input-invalid",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed for root input with inherited fields", async () => {
    const evaluate = vi.fn(() => ({ outcome: "pass" as const }));
    const registry = createPolicyRegistry([
      {
        pluginId: "plain-root-policy",
        policy: {
          id: "plain-root",
          description: "requires a plain root input",
          evaluate,
        },
      },
    ]);
    const params = Object.assign(Object.create({ inherited: "not-data" }), { local: "data" });

    await expect(
      runFinalToolInputPolicies(createEvent(params), baseContext, { registry }),
    ).resolves.toMatchObject({
      block: true,
      kind: "error",
      reasonCode: "policy-input-invalid",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed when a policy returns no explicit decision", async () => {
    const evaluations: string[] = [];
    const registry = createPolicyRegistry([
      {
        pluginId: "undefined-policy",
        policy: {
          id: "undefined",
          description: "returns no decision",
          evaluate() {
            evaluations.push("undefined");
            return undefined as never;
          },
        },
      },
      {
        pluginId: "later-policy",
        policy: {
          id: "later",
          description: "still runs after undefined",
          evaluate() {
            evaluations.push("later");
            return { outcome: "pass" };
          },
        },
      },
    ]);

    await expect(
      runFinalToolInputPolicies(createEvent(), baseContext, { registry }),
    ).resolves.toMatchObject({
      block: true,
      kind: "error",
      pluginId: "undefined-policy",
      policyId: "undefined",
      reasonCode: "policy-decision-invalid",
    });
    expect(evaluations).toEqual(["undefined"]);
  });

  it("fails closed on timeout and aborts the policy-local signal", async () => {
    vi.useFakeTimers();
    let policySignal: AbortSignal | undefined;
    const registry = createPolicyRegistry([
      {
        pluginId: "timeout-policy",
        policy: {
          id: "timeout",
          description: "never resolves",
          timeoutMs: 5,
          evaluate(_event, _ctx, signal) {
            policySignal = signal;
            return new Promise(() => {});
          },
        },
      },
    ]);

    const pending = runFinalToolInputPolicies(createEvent(), baseContext, { registry });
    await vi.advanceTimersByTimeAsync(5);

    await expect(pending).resolves.toMatchObject({
      block: true,
      kind: "error",
      reasonCode: "policy-evaluation-timed-out",
    });
    expect(policySignal?.aborted).toBe(true);
  });

  it("keeps caller cancellation distinct from policy denial", async () => {
    const controller = new AbortController();
    let policySignal: AbortSignal | undefined;
    const registry = createPolicyRegistry([
      {
        pluginId: "cancel-policy",
        policy: {
          id: "cancel",
          description: "observes cancellation",
          evaluate(_event, _ctx, signal) {
            policySignal = signal;
            return new Promise(() => {});
          },
        },
      },
    ]);

    const pending = runFinalToolInputPolicies(createEvent(), baseContext, {
      registry,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(policySignal).toBeDefined());
    controller.abort(new Error("run cancelled"));

    await expect(pending).resolves.toMatchObject({
      block: true,
      kind: "abort",
      reasonCode: "policy-evaluation-aborted",
    });
    expect(policySignal?.aborted).toBe(true);
  });

  it("classifies cancellation that races with a passing policy resolution as abort", async () => {
    const controller = new AbortController();
    const registry = createPolicyRegistry([
      {
        pluginId: "racing-cancel-policy",
        policy: {
          id: "racing-cancel",
          description: "aborts while its passing decision resolves",
          evaluate: () =>
            Promise.resolve().then(() => {
              controller.abort(new Error("cancelled during policy resolution"));
              return { outcome: "pass" } as const;
            }),
        },
      },
    ]);

    await expect(
      runFinalToolInputPolicies(createEvent(), baseContext, {
        registry,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      block: true,
      kind: "abort",
      reasonCode: "policy-evaluation-aborted",
    });
  });

  it("does not let a plugin reason code spoof host cancellation", async () => {
    const registry = createPolicyRegistry([
      {
        pluginId: "deny-policy",
        policy: {
          id: "deny",
          description: "uses a reserved-looking reason code",
          evaluate: () => ({
            outcome: "deny",
            reasonCode: "policy-evaluation-aborted",
          }),
        },
      },
    ]);

    await expect(
      runFinalToolInputPolicies(createEvent(), baseContext, { registry }),
    ).resolves.toMatchObject({
      block: true,
      kind: "deny",
      reasonCode: "policy-evaluation-aborted",
    });
  });

  it("scopes and caches session extension state per policy plugin", async () => {
    const seen: unknown[] = [];
    const registry = createPolicyRegistry(
      ["policy-a", "policy-b"].map((pluginId) => ({
        pluginId,
        policy: {
          id: "inspect-session-state",
          description: "inspect own session state",
          evaluate(_event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) {
            seen.push(ctx.getSessionExtension?.("policy"));
            seen.push(ctx.getSessionExtension?.("policy"));
            seen.push(ctx.getSessionExtension?.("missing"));
            return { outcome: "pass" as const };
          },
        },
      })),
    );

    await expect(
      runFinalToolInputPolicies(createEvent(), baseContext, {
        config: {} as never,
        registry,
      }),
    ).resolves.toBeUndefined();

    expect(seen).toEqual([
      { owner: "policy-a" },
      { owner: "policy-a" },
      undefined,
      { owner: "policy-b" },
      { owner: "policy-b" },
      undefined,
    ]);
    expect(getPluginSessionExtensionStateSyncMock).toHaveBeenCalledTimes(2);
    expect(
      getPluginSessionExtensionStateSyncMock.mock.calls.map(([call]) => call.pluginId),
    ).toEqual(["policy-a", "policy-b"]);
  });

  it("preserves full plugin ids for session-state ownership", async () => {
    const sharedPrefix = "p".repeat(128);
    const pluginIds = [`${sharedPrefix}-a`, `${sharedPrefix}-b`];
    const registry = createPolicyRegistry(
      pluginIds.map((pluginId) => ({
        pluginId,
        policy: {
          id: "inspect-long-owner",
          description: "inspect long plugin owner",
          evaluate(_event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) {
            expect(ctx.getSessionExtension?.("policy")).toEqual({ owner: pluginId });
            return { outcome: "pass" as const };
          },
        },
      })),
    );

    await expect(
      runFinalToolInputPolicies(createEvent(), baseContext, {
        config: {} as never,
        registry,
      }),
    ).resolves.toBeUndefined();

    expect(
      getPluginSessionExtensionStateSyncMock.mock.calls.map(([call]) => call.pluginId),
    ).toEqual(pluginIds);
  });
});

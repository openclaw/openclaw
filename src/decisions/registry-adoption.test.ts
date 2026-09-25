import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { runPluginRegisterSyncInRegistry } from "../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  bindPluginRegistryResourceOwner,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createDeferredCore } from "../shared/deferred.js";
import { DecisionProviderHost } from "./provider-host.js";
import { adoptRuntimeDecisionProviders } from "./registry-adoption.js";
import {
  evaluateDecisionInRegistry,
  inspectDecisionProviders,
  prepareDecisionProviderReload,
} from "./runtime.js";
import type { DecisionProviderV1, ProviderDecisionOutcome } from "./types.js";

const config = {
  agents: { defaults: { decisionModel: "fixture/synthetic" } },
  plugins: { entries: { owner: { enabled: true, config: { model: "synthetic" } } } },
};
const batch = { state: "synthetic", questions: { check: { type: "boolean" as const } } };
const answer: ProviderDecisionOutcome = {
  status: "ok",
  result: { model: "synthetic", answers: { check: { type: "boolean", probabilityTrue: 1 } } },
};
const options = () => ({
  purpose: "test",
  rubricVersion: "1",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
});

function fixture(evaluate: DecisionProviderV1["evaluate"] = async () => answer) {
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
      registration.registerDecisionProvider({ id: "fixture", contractVersion: 1, evaluate }),
    api,
    builder.registry,
    record.id,
  );
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  setPluginRuntimeLoadContext(builder.registry, {
    rawConfig: config,
    config,
    activationSourceConfig: config,
    autoEnabledReasons: {},
    workspaceDir: "/synthetic",
    env: process.env,
    logger: { info() {}, warn() {}, error() {} },
  });
  onTestFinished(async () => {
    await getPluginInstance(record)?.dispose();
  });
  const target = createEmptyPluginRegistry();
  const localRecord = { ...record };
  const duplicate = vi.fn(async () => answer);
  target.plugins.push(localRecord);
  target.decisionProviders.push({
    pluginId: record.id,
    host: new DecisionProviderHost(
      { id: "fixture", contractVersion: 1, evaluate: duplicate },
      localRecord,
    ),
  });
  const view = bindPluginRegistryResourceOwner(
    adoptRuntimeDecisionProviders(target, builder.registry, config),
    target,
  );
  const run = () => evaluateDecisionInRegistry(batch, options(), view, config);
  return { root: builder.registry, target, view, record, duplicate, run };
}

afterEach(() => resetPluginRuntimeStateForTest());

describe("prepared decision provider ownership", () => {
  it("shares Gateway counters, circuit state and instance custody across prepared views", async () => {
    const evaluate = vi.fn(async (): Promise<ProviderDecisionOutcome> => ({
      status: "unavailable",
      reason: "transport",
    }));
    const { root, target, view, record, duplicate, run } = fixture(evaluate);
    expect(view.decisionProviders[0]).toBe(root.decisionProviders[0]);
    expect(target.decisionProviders[0]).not.toBe(root.decisionProviders[0]);
    expect(collectRegistryInvocationInstances(view).has(getPluginInstance(record)!)).toBe(true);
    await run();
    await evaluateDecisionInRegistry(batch, options(), root, config);
    await run();
    expect(await evaluateDecisionInRegistry(batch, options(), root, config)).toEqual({
      status: "unavailable",
      reason: "circuit-open",
    });
    expect(inspectDecisionProviders(config, root)[0]?.reasons.transport).toBe(3);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("releases a prepared consumer without retiring the shared Gateway provider", async () => {
    let settled = false;
    const entered = createDeferredCore();
    const { root, target, view, run } = fixture(async (_batch, { signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        entered.resolve();
      });
      settled = true;
      signal.throwIfAborted();
      return answer;
    });
    // Prepared generation custody activates its finite primary registry without making it root.
    markPluginRegistryActive(target);
    const pending = run();
    await Promise.race([entered.promise, pending]);
    markPluginRegistryRetired(target);
    await expect(pending).rejects.toBeDefined();
    expect(settled).toBe(true);
    await expect(evaluateDecisionInRegistry(batch, options(), view, config)).rejects.toThrow(
      "consumer authority closed",
    );
    expect(inspectDecisionProviders(config, root)[0]).toMatchObject({
      callable: true,
      activeRequests: 0,
    });
  });

  it("shares the concurrency bound and joins provider retirement before fallback", async () => {
    const { root, record, run } = fixture(async (_batch, { signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      signal.throwIfAborted();
      return answer;
    });
    const pending = [
      run(),
      run(),
      evaluateDecisionInRegistry(batch, options(), root, config),
      run(),
    ];
    expect(await evaluateDecisionInRegistry(batch, options(), root, config)).toEqual({
      status: "unavailable",
      reason: "overloaded",
    });
    const pause = prepareDecisionProviderReload(root, new Set([record.id]));
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 4 }, () => ({ status: "unavailable", reason: "retiring" })),
    );
    await pause.rollback(new AbortController().signal);
    expect(inspectDecisionProviders(config, root)[0]).toMatchObject({
      callable: true,
      activeRequests: 0,
    });
  });

  it("never adopts across a shadowed source, changed config, or retired owner", () => {
    const { root, target } = fixture();
    expect(
      adoptRuntimeDecisionProviders(target, root, {
        ...config,
        plugins: { entries: { owner: { config: { model: "other" } } } },
      }),
    ).toBe(target);
    target.plugins[0]!.source = "/workspace/shadow.ts";
    expect(adoptRuntimeDecisionProviders(target, root, config)).toBe(target);
    target.plugins[0]!.source = root.plugins[0]!.source;
    markPluginRegistryRetired(root);
    expect(adoptRuntimeDecisionProviders(target, root, config)).toBe(target);
  });
});

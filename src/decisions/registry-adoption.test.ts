import { afterEach, expect, it, onTestFinished } from "vitest";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  bindPluginRegistryResourceOwner,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createToolLoadContext } from "../plugins/tools.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createDecisionRegistry, unavailable, waitForAbort } from "./contract.test-support.js";
import { DecisionProviderHost } from "./provider-host.js";
import type { DecisionProviderV1 } from "./provider-types.js";
import { adoptRuntimeDecisionProviders } from "./registry-adoption.js";
import {
  evaluateDecisionInRegistry,
  inspectDecisionProviders as inspect,
  prepareDecisionProviderReload,
} from "./runtime.js";
import { answer, batch, config as baseConfig, options } from "./runtime.test-support.js";

const config = {
  ...baseConfig,
  plugins: { entries: { owner: { enabled: true, config: { model: "synthetic" } } } },
};
function fixture(evaluate: DecisionProviderV1["evaluate"] = async () => answer) {
  const provider = { id: "fixture", contractVersion: 1 as const, evaluate };
  const { registry: root, record } = createDecisionRegistry(config, provider);
  setPluginRuntimeLoadContext(root, createToolLoadContext(config, "/synthetic"));
  onTestFinished(async () => {
    await getPluginInstance(record)?.dispose();
  });
  const target = createEmptyPluginRegistry();
  const localRecord = { ...record };
  target.plugins.push(localRecord);
  target.decisionProviders.push({
    pluginId: record.id,
    host: new DecisionProviderHost(provider, localRecord),
  });
  const view = bindPluginRegistryResourceOwner(
    adoptRuntimeDecisionProviders(target, root, config),
    target,
  );
  const run = (registry = view) => evaluateDecisionInRegistry(batch, options(), registry, config);
  return { root, target, record, run };
}

afterEach(() => resetPluginRuntimeStateForTest());
const expectRootReady = (root: Parameters<typeof inspect>[1]) =>
  expect(inspect(config, root)[0]).toMatchObject({ callable: true, activeRequests: 0 });

it("releases a prepared consumer without retiring the shared Gateway provider", async () => {
  let settled = false;
  const entered = createDeferredCore();
  const { root, target, run } = fixture(async (_batch, { signal }) => {
    await waitForAbort(signal, () => entered.resolve());
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
  await expect(run()).rejects.toThrow("consumer authority closed");
  expectRootReady(root);
});

it("shares the concurrency bound and joins provider retirement before fallback", async () => {
  const { root, record, run } = fixture(async (_batch, { signal }) => {
    await waitForAbort(signal);
    signal.throwIfAborted();
    return answer;
  });
  const pending = [run(), run(), run(root), run()];
  expect(await run(root)).toEqual(unavailable("overloaded"));
  const pause = prepareDecisionProviderReload(root, new Set([record.id]));
  expect(await Promise.all(pending)).toEqual(Array(4).fill(unavailable("retiring")));
  await pause.rollback(new AbortController().signal);
  expectRootReady(root);
});

it("never adopts across a shadowed source, changed config, or retired owner", () => {
  const { root, target } = fixture();
  const changed = { ...config, plugins: { entries: { owner: { config: { model: "other" } } } } };
  expect(adoptRuntimeDecisionProviders(target, root, changed)).toBe(target);
  target.plugins[0]!.source = "/workspace/shadow.ts";
  expect(adoptRuntimeDecisionProviders(target, root, config)).toBe(target);
  target.plugins[0]!.source = root.plugins[0]!.source;
  markPluginRegistryRetired(root);
  expect(adoptRuntimeDecisionProviders(target, root, config)).toBe(target);
});

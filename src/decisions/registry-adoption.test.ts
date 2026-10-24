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
import { createDeferredCore } from "../shared/deferred.js";
import { createDecisionRegistry, unavailable, waitForAbort } from "./contract.test-support.js";
import { DecisionProviderHost } from "./provider-host.js";
import { adoptRuntimeDecisionProviders } from "./registry-adoption.js";
import {
  evaluateDecisionInRegistry,
  inspectDecisionProviders as inspect,
  prepareDecisionProviderReload,
} from "./runtime.js";
import { options } from "./runtime.test-support.js";
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

function fixture(evaluate: DecisionProviderV1["evaluate"] = async () => answer) {
  const builder = createDecisionRegistry(config, { id: "fixture", contractVersion: 1, evaluate });
  const { record } = builder;
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
  target.plugins.push(localRecord);
  target.decisionProviders.push({
    pluginId: record.id,
    host: new DecisionProviderHost(
      { id: "fixture", contractVersion: 1, evaluate: async () => answer },
      localRecord,
    ),
  });
  const view = bindPluginRegistryResourceOwner(
    adoptRuntimeDecisionProviders(target, builder.registry, config),
    target,
  );
  const run = () => evaluateDecisionInRegistry(batch, options(), view, config);
  const runRoot = () => evaluateDecisionInRegistry(batch, options(), builder.registry, config);
  return { root: builder.registry, target, record, run, runRoot };
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
  const { root, record, run, runRoot } = fixture(async (_batch, { signal }) => {
    await waitForAbort(signal);
    signal.throwIfAborted();
    return answer;
  });
  const pending = [run(), run(), runRoot(), run()];
  expect(await runRoot()).toEqual(unavailable("overloaded"));
  const pause = prepareDecisionProviderReload(root, new Set([record.id]));
  expect(await Promise.all(pending)).toEqual(
    Array.from({ length: 4 }, () => unavailable("retiring")),
  );
  await pause.rollback(new AbortController().signal);
  expectRootReady(root);
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

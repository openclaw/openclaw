import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { retainPreparedPluginRegistry } from "../agents/prepared-model-runtime.plugin-lifetime.js";
import { activatePluginRegistry } from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { acquirePluginRegistryForInspection, loadOpenClawPlugins } from "./loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginRegistry } from "./registry-types.js";
import { clearActivePluginRegistry, disposePluginRegistryInstances } from "./runtime.js";
import { bindPluginToolCallbacks } from "./tool-factory-runtime.js";

const lenderId = "borrow-lender";
const freshId = "borrow-fresh";
const evaluations = Symbol.for("openclaw.test.borrowEvaluations");

function writeProbePlugin(id: string, body = "") {
  const plugin = writePlugin({
    id,
    body: `const counts = (globalThis[Symbol.for("openclaw.test.borrowEvaluations")] ??= {});
      counts[${JSON.stringify(id)}] = (counts[${JSON.stringify(id)}] ?? 0) + 1;
      const generation = counts[${JSON.stringify(id)}];
      ${body}
      module.exports = { id: ${JSON.stringify(id)}, register(api) {
        api.registerTool({ name: ${JSON.stringify(`${id.replaceAll("-", "_")}_probe`)},
          description: "Report the module generation", parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: String(generation) }] }; } });
      } };`,
  });
  writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      configSchema: { type: "object", properties: {} },
      contracts: { tools: [`${id.replaceAll("-", "_")}_probe`] },
    }),
  );
  return plugin;
}

const registries: PluginRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0).toReversed()) {
    await disposePluginRegistryInstances(registry);
  }
  await clearActivePluginRegistry();
  Reflect.deleteProperty(globalThis, evaluations);
  resetPluginLoaderTestStateForTest();
});

/** A Gateway-mode lender plus the options a prepared, non-activating load uses to borrow from it. */
function setupLender(freshBody?: string) {
  useNoBundledPlugins();
  const lender = writeProbePlugin(lenderId);
  const fresh = writeProbePlugin(freshId, freshBody);
  const options: PluginLoadOptions = {
    config: {
      plugins: {
        allow: [lenderId, freshId],
        load: { paths: [lender.file, fresh.file] },
        slots: { memory: "none" },
      },
    },
    cache: false,
  };
  const gateway = loadOpenClawPlugins({
    ...options,
    onlyPluginIds: [lenderId],
    activate: false,
    runtimeSideEffects: true,
  });
  registries.push(gateway);
  activatePluginRegistry(gateway, null, "gateway-bindable");
  const gatewayRecord = gateway.plugins.find((record) => record.id === lenderId);
  const gatewayInstance = gatewayRecord && getPluginInstance(gatewayRecord);
  if (!gatewayRecord || !gatewayInstance) {
    throw new Error("Expected the Gateway-owned lender instance");
  }
  const borrowOptions: PluginLoadOptions = {
    ...options,
    activate: false,
    preferBuiltPluginArtifacts: true,
    borrowRegistry: gateway,
  };
  return { gateway, gatewayRecord, gatewayInstance, borrowOptions };
}

function bindProbe(registry: PluginRegistry, pluginId: string) {
  const entry = registry.tools.find((tool) => tool.pluginId === pluginId);
  const tool = entry?.factory({});
  if (!entry || !tool || Array.isArray(tool)) {
    throw new Error(`Expected the ${pluginId} probe tool`);
  }
  return bindPluginToolCallbacks(entry, registry, tool);
}

const firstGeneration = { content: [{ type: "text", text: "1" }] };

it.each(["prepared", "inspection"] as const)(
  "releases a %s registry without disposing borrowed Gateway instances",
  async (mode) => {
    const { gateway, gatewayRecord, gatewayInstance, borrowOptions } = setupLender();
    const { cache: _cache, ...inspectionOptions } = borrowOptions;
    const inspection =
      mode === "inspection"
        ? await acquirePluginRegistryForInspection(inspectionOptions)
        : undefined;
    const prepared = inspection?.registry ?? loadOpenClawPlugins(borrowOptions);
    if (!inspection) {
      registries.push(prepared);
    }
    const freshRecord = prepared.plugins.find((record) => record.id === freshId);
    const freshInstance = freshRecord && getPluginInstance(freshRecord);
    expect(prepared.plugins.find((record) => record.id === lenderId)).toBe(gatewayRecord);
    expect(freshRecord?.status).toBe("loaded");
    expect(Reflect.get(globalThis, evaluations)).toEqual({ [lenderId]: 1, [freshId]: 1 });
    await expect(bindProbe(prepared, lenderId).execute("borrowed", {})).resolves.toMatchObject(
      firstGeneration,
    );

    const release = inspection?.release ?? retainPreparedPluginRegistry(prepared);
    expect(gatewayInstance.owner?.registry).toBe(gateway);
    await release?.();
    expect(freshInstance?.acceptingCalls).toBe(false);
    expect(gatewayInstance.acceptingCalls).toBe(true);
    expect(gatewayInstance.disposing).toBe(false);
    await expect(bindProbe(gateway, lenderId).execute("lender", {})).resolves.toMatchObject(
      firstGeneration,
    );
  },
);

it("rolls back a failed borrowing load without retiring borrowed Gateway instances", async () => {
  const { gateway, gatewayInstance, borrowOptions } = setupLender(
    'throw new Error("fresh plugin failed");',
  );
  expect(() => loadOpenClawPlugins({ ...borrowOptions, throwOnLoadError: true })).toThrow(
    /fresh plugin failed|failed to load/,
  );
  expect(gatewayInstance.acceptingCalls).toBe(true);
  expect(gatewayInstance.disposing).toBe(false);
  await expect(bindProbe(gateway, lenderId).execute("lender", {})).resolves.toMatchObject(
    firstGeneration,
  );
});

it("stops borrowed callbacks when the lending Gateway retires the instance", async () => {
  const { gateway, borrowOptions } = setupLender();
  const prepared = loadOpenClawPlugins(borrowOptions);
  registries.push(prepared);
  const bound = bindProbe(prepared, lenderId);
  await expect(bound.execute("before", {})).resolves.toMatchObject(firstGeneration);
  await disposePluginRegistryInstances(gateway);
  await expect(bound.execute("after", {})).rejects.toThrow(/no longer active/);
});

it.each([true, false])("never adopts a predecessor's loan (lender supplied: %s)", async (lend) => {
  const { gateway, gatewayRecord, gatewayInstance, borrowOptions } = setupLender();
  const first = loadOpenClawPlugins({ ...borrowOptions, onlyPluginIds: [lenderId] });
  registries.push(first);
  const releaseFirst = retainPreparedPluginRegistry(first);
  const next = loadOpenClawPlugins({
    ...borrowOptions,
    onlyPluginIds: [lenderId],
    previousRegistry: first,
    borrowRegistry: lend ? gateway : undefined,
  });
  registries.push(next);
  const releaseNext = retainPreparedPluginRegistry(next);
  try {
    expect.soft(next.plugins[0] === gatewayRecord).toBe(lend);
    expect.soft(gatewayInstance.owner?.registry).toBe(gateway);
    await releaseFirst?.();
    await expect(bindProbe(next, lenderId).execute("successor", {})).resolves.toMatchObject({
      content: [{ type: "text", text: lend ? "1" : "2" }],
    });
    await releaseNext?.();
    expect.soft(gatewayInstance.acceptingCalls).toBe(true);
    await expect(bindProbe(gateway, lenderId).execute("gateway", {})).resolves.toMatchObject(
      firstGeneration,
    );
  } finally {
    await releaseFirst?.();
    await releaseNext?.();
  }
});

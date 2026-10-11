import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => ({ acquirePluginRegistryForInspection: vi.fn() }));
vi.mock("./loader.js", () => loaders);

import { acquireAgentRuntimePluginRegistry } from "../agents/runtime-plugins.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { PluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import {
  bindPluginRegistryGatewayOwner,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "./registry-lifecycle.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import type { PluginRegistry, PluginToolRegistration } from "./registry-types.js";
import {
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "./runtime/load-context.js";
import { startPluginServices, type PluginServicesHandle } from "./services.test-support.js";
import { adoptRuntimeToolRegistrations } from "./tool-registry-adoption.js";

const workspaceDir = "/synthetic";
const recordOptions = {
  id: "owner",
  source: "/synthetic/plugin.ts",
  origin: "global" as const,
  enabled: true,
  configSchema: false,
};

function setLoadContext(registry: PluginRegistry, config: OpenClawConfig) {
  setPluginRuntimeLoadContext(registry, {
    rawConfig: config,
    config,
    activationSourceConfig: config,
    autoEnabledReasons: {},
    workspaceDir,
    env: process.env,
    logger: { info() {}, warn() {}, error() {} },
  });
}

function createAdoptionPair(config: OpenClawConfig) {
  const runtime = createEmptyPluginRegistry();
  const target = createEmptyPluginRegistry();
  const record = createPluginRecord(recordOptions);
  const localRecord = { ...record };
  runtime.plugins.push(record);
  target.plugins.push(localRecord);
  setLoadContext(runtime, config);
  markPluginRegistryActive(runtime);
  const tool = (names: string[], optional = false): PluginToolRegistration => ({
    pluginId: record.id,
    source: record.source,
    factory: () => null,
    names,
    optional,
  });
  return { runtime, target, record, localRecord, tool };
}

it("keeps discovery tools when the Gateway source, config, or lifetime does not match", () => {
  const config = { plugins: { entries: { owner: { config: { account: "original" } } } } };
  const { runtime, target, record, localRecord, tool: createTool } = createAdoptionPair(config);
  const tool = createTool(["owner_tool"]);
  runtime.tools.push(tool);
  const localTool = { ...tool, factory: () => null };
  target.tools.push(localTool);
  try {
    expect(adoptRuntimeToolRegistrations(target, runtime, config).tools).toEqual([tool]);
    expect(target.tools).toEqual([localTool]);
    expect(
      adoptRuntimeToolRegistrations(target, runtime, {
        plugins: { entries: { owner: { config: { account: "other" } } } },
      }),
    ).toBe(target);
    localRecord.source = "/workspace/shadow.ts";
    expect(adoptRuntimeToolRegistrations(target, runtime, config)).toBe(target);
    localRecord.source = record.source;
    localRecord.enabled = false;
    expect(adoptRuntimeToolRegistrations(target, runtime, config)).toBe(target);
    localRecord.enabled = true;
    markPluginRegistryRetired(runtime);
    expect(adoptRuntimeToolRegistrations(target, runtime, config)).toBe(target);
  } finally {
    markPluginRegistryRetired(runtime);
  }
});

it("substitutes exact declared identities without widening or reordering discovery tools", () => {
  const config = {};
  const { runtime, target, tool } = createAdoptionPair(config);
  const x = tool(["x"]);
  const y = tool(["y"]);
  runtime.tools.push(y, x);
  const localX = tool(["x"]);
  target.tools.push(localX);
  try {
    expect.soft(adoptRuntimeToolRegistrations(target, runtime, config).tools).toEqual([x]);
    const unnamed = tool([]);
    const optional = tool(["x"], true);
    const grouped = tool(["second", "first"]);
    const ownedGroup = tool(["first", "second", "first"]);
    const unmatched = tool(["missing"]);
    runtime.tools.push(tool([]), ownedGroup);
    target.tools = [unnamed, grouped, optional, localX, unmatched];
    expect
      .soft(adoptRuntimeToolRegistrations(target, runtime, config).tools)
      .toEqual([unnamed, ownedGroup, optional, x, unmatched]);
    expect(target.tools).toEqual([unnamed, grouped, optional, localX, unmatched]);

    // A null-returning fallback may share its declared name with the registration that supplies it.
    const fallback = tool(["z"]);
    const supplier = tool(["z"]);
    runtime.tools.push(fallback, supplier);
    target.tools = [tool(["z"]), tool(["z"])];
    const [first, second] = adoptRuntimeToolRegistrations(target, runtime, config).tools;
    expect.soft(first).toBe(fallback);
    expect.soft(second).toBe(supplier);
    target.tools = [tool(["z"])];
    expect(adoptRuntimeToolRegistrations(target, runtime, config)).toBe(target);
  } finally {
    markPluginRegistryRetired(runtime);
  }
});

afterEach(() => resetPluginRuntimeStateForTest());

it("executes only the admitting Gateway's current service and skips unowned turns", async () => {
  const config = { plugins: { allow: ["owner"], slots: { memory: "none" } } };
  const metadataSnapshot = createPluginMetadataSnapshot({
    config,
    workspaceDir,
    manifestRegistry: makeRegistry([{ id: "owner", origin: "global", channels: [] }]),
  });
  const store = createPluginRuntimeStore<{ call: () => string }>({
    key: "tool-adoption-service",
    errorMessage: "service is not started",
  });
  const create = (marker: string) => {
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      ...recordOptions,
      contracts: { tools: ["owner_tool"] },
    });
    const api = builder.createApi(record, { config });
    const call = vi.fn(() => marker);
    api.registerTool(
      () => ({
        name: "owner_tool",
        label: "Owner",
        description: "Read owning service",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { content: [{ type: "text", text: store.getRuntime().call() }], details: {} };
        },
      }),
      { names: ["owner_tool"] },
    );
    api.registerService({
      id: "owner-service",
      start() {
        store.setRuntime({ call });
      },
      stop() {
        store.clearRuntime();
      },
    });
    builder.registry.plugins.push(record);
    setLoadContext(builder.registry, config);
    return { registry: builder.registry, instance: getPluginInstance(record)!, call };
  };
  const a = create("Gateway A");
  // A request may retain a previous registry while its admitting owner publishes a successor.
  const requestRegistry = createEmptyPluginRegistry();
  setActivePluginRegistry(requestRegistry);
  const ownerA = createPluginRegistryOwner(requestRegistry);
  setActivePluginRegistry(a.registry);
  ownerA.publish(a.registry);
  const services: PluginServicesHandle[] = [];
  const acquired: Awaited<ReturnType<typeof acquireAgentRuntimePluginRegistry>>[] = [];
  const selected: ReturnType<typeof create>[] = [];
  const prepare = () => {
    const local = create("discovery");
    selected.push(local);
    const resources = new PluginRegistryInspectionResources(async () => {
      await local.instance.dispose();
    });
    resources.attach(local.registry);
    loaders.acquirePluginRegistryForInspection.mockResolvedValueOnce({
      registry: local.registry,
      release: () => resources.release(),
    });
    return acquireAgentRuntimePluginRegistry({
      config,
      workspaceDir,
      metadataSnapshot,
      allowGatewaySubagentBinding: true,
    });
  };
  try {
    await startPluginServices({
      registry: a.registry,
      config,
      workspaceDir,
      throwOnStartError: true,
      onHandle: (handle) => {
        services.push(handle);
      },
    });
    const owned = await withPluginRuntimeRegistryScope(requestRegistry, prepare);
    acquired.push(owned);
    assert("resources" in owned);
    expect.soft(owned.registry.tools).toEqual(a.registry.tools);
    expect.soft(a.instance.retainedWorkCount).toBeGreaterThan(0);
    const scope = owned.resources.createInvocationScope(owned.registry);
    try {
      const tool = scope.wrap(owned.registry.tools[0]!.factory)({ config, workspaceDir });
      assert(tool && !Array.isArray(tool));
      expect
        .soft(await tool.execute("owned-tool", {}))
        .toMatchObject({ content: [{ type: "text", text: "Gateway A" }] });
      expect.soft(a.call).toHaveBeenCalledOnce();
    } finally {
      scope.release();
    }
    const unscoped = await prepare();
    acquired.push(unscoped);
    expect.soft(unscoped.registry.tools).toEqual(selected[1]!.registry.tools);
    const ambiguous = createEmptyPluginRegistry();
    bindPluginRegistryGatewayOwner(ambiguous, { current: () => a.registry });
    bindPluginRegistryGatewayOwner(ambiguous, { current: () => createEmptyPluginRegistry() });
    const unowned = await withPluginRuntimeRegistryScope(ambiguous, prepare);
    acquired.push(unowned);
    expect.soft(unowned.registry.tools).toEqual(selected[2]!.registry.tools);
  } finally {
    for (const lease of acquired) {
      if ("releaseRegistry" in lease) {
        await lease.releaseRegistry();
        lease.releaseWork();
      }
    }
    for (const service of services) {
      await service.stop({ strict: true });
    }
    await ownerA.close();
    for (const local of selected) {
      await local.instance.dispose();
    }
  }
  expect(a.instance.retainedWorkCount).toBe(0);
});

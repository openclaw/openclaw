import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => ({ acquirePluginRegistryForInspection: vi.fn() }));
vi.mock("./loader.js", () => loaders);

import { acquireAgentRuntimePluginRegistry } from "../agents/runtime-plugins.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { createHookRunner } from "./hooks.js";
import { createPluginRecord } from "./loader-records.js";
import {
  getPluginInstance,
  getPluginValueInstance,
  type PluginInstanceHandle,
} from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { collectRegistryInvocationInstances } from "./plugin-invocation-scope.js";
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
import { makeTool } from "./tools.optional.test-helpers.js";
import { createToolLoadContext } from "./tools.test-support.js";

const workspaceDir = "/synthetic";
const recordOptions = {
  id: "owner",
  source: "/synthetic/plugin.ts",
  origin: "global" as const,
  enabled: true,
  configSchema: false,
};

function setLoadContext(registry: PluginRegistry, config: OpenClawConfig) {
  setPluginRuntimeLoadContext(registry, createToolLoadContext(config, workspaceDir));
}

const runtimes = new Set<PluginRegistry>();
const instances = new Set<PluginInstanceHandle>();
afterEach(async () => {
  for (const runtime of runtimes) {
    markPluginRegistryRetired(runtime);
  }
  runtimes.clear();
  await Promise.all([...instances].map((instance) => instance.dispose()));
  instances.clear();
  resetPluginRuntimeStateForTest();
});

function createAdoptionPair(config: OpenClawConfig = {}) {
  const runtime = createEmptyPluginRegistry();
  const target = createEmptyPluginRegistry();
  const record = createPluginRecord(recordOptions);
  const localRecord = { ...record };
  runtime.plugins.push(record);
  target.plugins.push(localRecord);
  for (const [registry, currentRecord] of [
    [runtime, record],
    [target, localRecord],
  ] as const) {
    const instance = new PluginInstance(currentRecord.id, { registry, record: currentRecord });
    instance.sourceDigest = "1".repeat(64);
    instances.add(instance);
  }
  setLoadContext(runtime, config);
  markPluginRegistryActive(runtime);
  runtimes.add(runtime);
  const tool = (names: string[], optional = false): PluginToolRegistration => ({
    pluginId: record.id,
    source: record.source,
    factory: () => null,
    names,
    optional,
  });
  const adopt = (nextConfig = config) => adoptRuntimeToolRegistrations(target, runtime, nextConfig);
  return { runtime, target, localRecord, tool, adopt };
}

it("keeps discovery tools when the Gateway source, config, or lifetime does not match", () => {
  const config = { plugins: { entries: { owner: { config: { account: "original" } } } } };
  const { runtime, target, localRecord, tool, adopt } = createAdoptionPair(config);
  runtime.tools.push(tool(["owner_tool"]));
  target.tools.push(tool(["owner_tool"]));
  expect(adopt().tools[0]).toBe(runtime.tools[0]);
  expect(
    adopt({
      plugins: { entries: { owner: { config: { account: "other" } } } },
    }),
  ).toBe(target);
  localRecord.source = "/workspace/shadow.ts";
  expect(adopt()).toBe(target);
  localRecord.source = recordOptions.source;
  localRecord.enabled = false;
  expect(adopt()).toBe(target);
  localRecord.enabled = true;
  markPluginRegistryRetired(runtime);
  expect(adopt()).toBe(target);
});

it("requires complete selected registrations and preserves repeated fallback order", () => {
  const { runtime, target, tool, adopt } = createAdoptionPair();
  const x = tool(["x"]);
  runtime.tools.push(tool(["y"]), x);
  const localX = tool(["x"]);
  const unnamed = tool([]);
  const optional = tool(["x"], true);
  const grouped = tool(["second", "first"]);
  const ownedGroup = tool(["first", "second", "first"]);
  const unmatched = tool(["missing"]);
  runtime.tools.push(tool([]), ownedGroup);
  target.tools = [unnamed, grouped, optional, localX, unmatched];
  expect.soft(adopt()).toBe(target);
  expect(target.tools).toEqual([unnamed, grouped, optional, localX, unmatched]);

  // A null-returning fallback may share its declared name with the registration that supplies it.
  const fallback = tool(["z"]);
  const supplier = tool(["z"]);
  runtime.tools = [fallback, supplier];
  target.tools = [tool(["z"]), tool(["z"])];
  const [first, second] = adopt().tools;
  expect.soft(first).toBe(fallback);
  expect.soft(second).toBe(supplier);
  target.tools = [tool(["z"])];
  expect(adopt()).toBe(target);
});

it("matches tools without entering unrelated plugin metadata", async () => {
  const { runtime, target, tool, adopt } = createAdoptionPair();
  const donor = tool(["owner_tool"]);
  const unrelated = new PluginInstance("unrelated");
  const foreign = { ...tool(unrelated.wrap(["foreign_tool"])), pluginId: "unrelated" };
  runtime.tools.push(foreign, donor);
  target.tools.push(tool(["owner_tool"]), foreign);
  await unrelated.dispose();
  expect(adopt().tools).toEqual([donor, foreign]);
});

it.each([false, true])(
  "executes selected tools on the admitting Gateway's current service and skips unowned turns (unnamed donor: %s)",
  async (unnamedDonor) => {
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
    const create = (marker: string, toolNames = ["owner_tool"], includeUnnamed = false) => {
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({
        ...recordOptions,
        contracts: { tools: ["owner_tool", "unselected_tool"] },
      });
      const api = builder.createApi(record, { config });
      getPluginInstance(record)!.sourceDigest = "1".repeat(64);
      const call = vi.fn(() => marker);
      for (const name of toolNames) {
        api.registerTool(
          () => ({
            ...makeTool(name),
            label: "Owner",
            async execute() {
              return { content: [{ type: "text", text: store.getRuntime().call() }], details: {} };
            },
          }),
          { names: [name] },
        );
      }
      if (includeUnnamed) {
        api.registerTool(() => ({
          ...makeTool("unselected_tool"),
          label: "Unselected",
          async execute() {
            return { content: [], details: {} };
          },
        }));
      }
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
    const a = create(
      "Gateway A",
      unnamedDonor ? ["owner_tool"] : ["unselected_tool", "owner_tool"],
      unnamedDonor,
    );
    expect(a.registry.tools).toHaveLength(2);
    expect(a.registry.tools.some((entry) => entry.names.length === 0)).toBe(unnamedDonor);
    // A request may retain a previous registry while its admitting owner publishes a successor.
    const requestRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(requestRegistry);
    const ownerA = createPluginRegistryOwner(requestRegistry);
    setActivePluginRegistry(a.registry);
    ownerA.publish(a.registry);
    let service: PluginServicesHandle | undefined;
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
          service = handle;
        },
      });
      const owned = await withPluginRuntimeRegistryScope(requestRegistry, prepare);
      acquired.push(owned);
      assert("resources" in owned);
      expect
        .soft(owned.registry.tools)
        .toEqual([a.registry.tools.find((entry) => entry.names.includes("owner_tool"))]);
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
      await service?.stop({ strict: true });
      await ownerA.close();
      for (const local of selected) {
        await local.instance.dispose();
      }
    }
    expect(a.instance.retainedWorkCount).toBe(0);
  },
);

describe("coherent Gateway service owner", () => {
  const config: OpenClawConfig = {
    plugins: { entries: { owner: { enabled: true, hooks: { allowConversationAccess: true } } } },
  };
  function create(
    ownerName: string,
    names: string[][] = [["owner_tool"]],
    hookCount = 1,
    declaredNames = names.flatMap((group) => (group.length ? group : ["unnamed"])),
  ) {
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "owner",
      source: "/synthetic/plugin.ts",
      origin: "global",
      enabled: true,
      configSchema: false,
      contracts: {
        tools: [...new Set(declaredNames)],
      },
    });
    builder.registry.plugins.push(record);
    const api = builder.createApi(record, {
      config,
      hookPolicy: { allowConversationAccess: true },
    });
    const instance = getPluginInstance(record)!;
    instance.sourceDigest = "1".repeat(64);
    instances.add(instance);
    runtimes.add(builder.registry);
    const proofs = new Set<string>();
    const calls: string[] = [];
    for (let i = 0; i < hookCount; i++) {
      api.on("before_tool_call", (event) => {
        calls.push(ownerName);
        const proof = ownerName + ":" + String(event.params.marker);
        proofs.add(proof);
        return { params: { ...event.params, proof } };
      });
    }
    api.registerHook(
      "session:synthetic",
      async () => {
        calls.push(ownerName + ":legacy");
      },
      { name: "synthetic-owner-hook" },
    );
    for (const group of names) {
      api.registerTool(
        () => ({
          name: group[0] ?? "unnamed",
          label: "Synthetic",
          description: "No external effects",
          parameters: { type: "object", properties: {} },
          execute: async (_id: string, params: Record<string, unknown>) => ({
            content: [{ type: "text", text: ownerName }],
            details: { ownerName, accepted: proofs.delete(String(params.proof)) },
          }),
        }),
        { names: group },
      );
    }
    expect(builder.registry.tools).toHaveLength(names.length);
    setPluginRuntimeLoadContext(builder.registry, createToolLoadContext(config, "/synthetic"));
    markPluginRegistryActive(builder.registry);
    return { registry: builder.registry, record, instance, calls };
  }
  function pair(localNames?: string[][], donorNames?: string[][], localHooks = 1, donorHooks = 1) {
    const declaredNames = [
      ...(localNames ?? [["owner_tool"]]),
      ...(donorNames ?? [["owner_tool"]]),
    ].flatMap((group) => (group.length ? group : ["unnamed"]));
    const donor = create("donor", donorNames, donorHooks, declaredNames);
    const local = create("local", localNames, localHooks, declaredNames);
    return {
      donor,
      local,
      adopt: (next = config) => adoptRuntimeToolRegistrations(local.registry, donor.registry, next),
    };
  }
  async function run(registry: PluginRegistry, marker = "GWTEST_OWNER") {
    const result = await createHookRunner(registry, { catchErrors: false }).runBeforeToolCall(
      { toolName: "owner_tool", params: { marker } },
      { toolName: "owner_tool" },
    );
    const raw = registry.tools[0]!.factory({ config, workspaceDir: "/synthetic" });
    if (!raw || Array.isArray(raw)) {
      throw new Error("Expected one fixture tool");
    }
    return raw.execute(marker, result?.params ?? { marker });
  }
  it("keeps selected hook/tool state with the Gateway service owner without adding donor tools", async () => {
    const { donor, local, adopt } = pair([["owner_tool"]], [["owner_tool"], ["extra"]]);
    const selected = adopt();
    expect(selected.tools).toHaveLength(1);
    expect(selected.tools[0]).toBe(donor.registry.tools[0]);
    expect(selected.plugins).toBe(local.registry.plugins);
    expect((await run(selected)).details).toMatchObject({ ownerName: "donor", accepted: true });
    expect(donor.calls).toEqual(["donor"]);
    expect(local.calls).toEqual([]);
    expect(local.registry.tools[0]).not.toBe(donor.registry.tools[0]);
    expect(selected.typedHooks).not.toBe(local.registry.typedHooks);
  });
  it.each([
    [[[]], [["owner_tool"]]],
    [
      [["owner_tool"], []],
      [["owner_tool"], []],
    ],
    [[["owner_tool"]], [[]]],
    [[["owner_tool"], ["extra"]], [["owner_tool"]]],
    [[["owner_tool"], ["owner_tool"]], [["owner_tool"]]],
  ])("declines the entire plugin for incomplete or unnamed tool sets %j / %j", (locals, donors) => {
    const { local, adopt } = pair(locals, donors);
    expect(adopt()).toBe(local.registry);
  });
  it("pairs repeated identities one-to-one in original tool order", () => {
    const { donor, adopt } = pair(
      [["owner_tool"], ["owner_tool"]],
      [["owner_tool"], ["owner_tool"]],
    );
    expect(adopt().tools).toEqual(donor.registry.tools);
  });
  it("declines same-path source drift, unknown digest, config and hook-policy mismatch", () => {
    const { donor, local, adopt } = pair();
    donor.instance.sourceDigest = "2".repeat(64);
    expect(adopt()).toBe(local.registry);
    donor.instance.sourceDigest = "1".repeat(64);
    local.instance.sourceDigest = undefined;
    expect(adopt()).toBe(local.registry);
    local.instance.sourceDigest = "1".repeat(64);
    expect(
      adopt({
        plugins: {
          entries: {
            owner: { config: { changed: true }, hooks: { allowConversationAccess: true } },
          },
        },
      }),
    ).toBe(local.registry);
    expect(
      adopt({ plugins: { entries: { owner: { hooks: { allowConversationAccess: false } } } } }),
    ).toBe(local.registry);
  });
  it.each([
    [0, 1],
    [1, 0],
    [1, 2],
  ])(
    "replaces the complete hook suite (%i local / %i donor), without duplicates",
    async (localHooks, donorHooks) => {
      const { donor, local, adopt } = pair(undefined, undefined, localHooks, donorHooks);
      const selected = adopt();
      expect(selected.typedHooks).toHaveLength(donorHooks);
      if (donorHooks > 0) {
        expect((await run(selected)).details).toMatchObject({ ownerName: "donor", accepted: true });
      }
      expect(local.calls).toEqual([]);
      expect(donor.calls).toHaveLength(donorHooks);
    },
  );
  it("keeps both invocation owners represented for native custody collection", () => {
    const { donor, local, adopt } = pair();
    const selected = adopt();
    const represented = collectRegistryInvocationInstances(selected);
    expect(represented.has(donor.instance)).toBe(true);
    expect(represented.has(local.instance)).toBe(true);
    expect(getPluginValueInstance(selected.tools[0]!.factory)).toBe(donor.instance);
  });
  it.each(["local", "donor"] as const)(
    "closes retained hook callbacks when the %s instance retires",
    async (retired) => {
      const fixture = pair([["owner_tool"]], [["owner_tool"], ["extra"]]);
      const selected = fixture.adopt();
      await fixture[retired].instance.dispose();
      await expect(
        createHookRunner(selected, { catchErrors: false }).runBeforeToolCall(
          { toolName: "owner_tool", params: { marker: "GWTEST_RETIRED" } },
          { toolName: "owner_tool" },
        ),
      ).rejects.toThrow(/closed|retir|dispos|active|reload|disabled/i);
    },
  );

  it("moves legacy hook metadata and handlers as the same complete owner suite", async () => {
    const { donor, local, adopt } = pair();
    const selected = adopt();
    expect(selected.hooks).toHaveLength(donor.registry.hooks.length);
    expect(selected.legacyInternalHooks).toHaveLength(1);
    expect(selected.hooks[0]!.entry).toEqual(donor.registry.hooks[0]!.entry);
    await selected.legacyInternalHooks[0]!.handler({
      type: "session",
      action: "synthetic",
      sessionKey: "synthetic",
      timestamp: new Date(),
      messages: [],
      context: {},
    });
    expect(donor.calls).toEqual(["donor:legacy"]);
    expect(local.calls).toEqual([]);
  });
  it("declines different global internal-hook policy without adding donor handlers", () => {
    const { local, adopt } = pair();
    expect(adopt({ ...config, hooks: { internal: { enabled: false } } })).toBe(local.registry);
  });
  it.each(["contextVersion", "declaredNames"] as const)(
    "declines an incompatible %s tool contract atomically",
    (field) => {
      const { donor, local, adopt } = pair();
      if (field === "contextVersion") {
        donor.registry.tools[0]!.contextVersion = 2;
      } else {
        donor.registry.tools[0]!.declaredNames = new Set(["different"]);
      }
      expect(adopt()).toBe(local.registry);
    },
  );
});

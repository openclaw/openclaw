import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import {
  loadAndActivateRootPluginRegistry,
  loadPluginRegistryHandle,
  resolveCompatibleRuntimePluginRegistry,
} from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { bindPluginRegistryRuntime } from "./registry-runtime-binding.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import type { PluginRuntime } from "./runtime/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
  resetPluginLoaderTestStateForTest();
  clearRuntimeConfigSnapshot();
});

afterAll(cleanupPluginLoaderFixturesForTest);

it.each([
  { explicit: "neither facet", nodes: false, subagent: false, activate: false },
  { explicit: "nodes", nodes: true, subagent: false, activate: false },
  { explicit: "subagent", nodes: false, subagent: true, activate: false },
  { explicit: "both facets", nodes: true, subagent: true, activate: false },
  {
    explicit: "neither facet after root activation",
    nodes: false,
    subagent: false,
    activate: true,
  },
])("refreshes borrowed Gateway bindings with explicit $explicit", async (explicit) => {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "runtime-owner-probe",
    registration: `api.registerTool({
      name: "runtime_owner_probe", description: "Read bound runtime owners",
      parameters: { type: "object", properties: {} },
      async execute() {
        const { nodes } = await api.runtime.nodes.list();
        const { messages } = await api.runtime.subagent.getSessionMessages({ sessionKey: "probe" });
        return { content: [], details: { nodes: nodes.map(node => node.nodeId), messages } };
      },
    });`,
  });
  writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      contracts: { tools: ["runtime_owner_probe"] },
    }),
  );
  const createFacets = (owner: string): Pick<PluginRuntime, "nodes" | "subagent"> => ({
    nodes: {
      list: async () => ({ nodes: [{ nodeId: owner }] }),
      invoke: vi.fn<PluginRuntime["nodes"]["invoke"]>(),
      openDuplex: vi.fn<PluginRuntime["nodes"]["openDuplex"]>(),
    },
    subagent: {
      complete: vi.fn<PluginRuntime["subagent"]["complete"]>(),
      run: vi.fn<PluginRuntime["subagent"]["run"]>(),
      waitForRun: vi.fn<PluginRuntime["subagent"]["waitForRun"]>(),
      getSessionMessages: async () => ({ messages: [owner] }),
      deleteSession: vi.fn<PluginRuntime["subagent"]["deleteSession"]>(),
    },
  });
  const loadPluginModule = vi.fn((_modulePath: string): unknown => {
    throw new Error("borrowed facets must not load the broad runtime");
  });
  const createDonor = (owner: string) => {
    const facets = createFacets(owner);
    const reads = {
      nodes: vi.fn(() => facets.nodes),
      subagent: vi.fn(() => facets.subagent),
    };
    const registry = createEmptyPluginRegistry();
    bindPluginRegistryRuntime(
      registry,
      createLazyPluginRuntime({
        loadPluginModule,
        runtimeOptions: {
          get nodes() {
            return reads.nodes();
          },
          get subagent() {
            return reads.subagent();
          },
        },
      }),
    );
    return { registry, reads };
  };
  const supplied = createFacets("explicit");
  const options = {
    config: {
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        slots: { memory: "none" },
      },
    },
    runtimeOptions: {
      allowGatewaySubagentBinding: true,
      ...(explicit.nodes ? { nodes: supplied.nodes } : {}),
      ...(explicit.subagent ? { subagent: supplied.subagent } : {}),
    },
  };
  const read = async (registry: ReturnType<typeof loadPluginRegistryHandle>) => {
    const tool = registry.tools[0]?.factory({ config: options.config });
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected one runtime owner probe tool");
    }
    return await tool.execute("probe", {});
  };
  if (explicit.activate) {
    const donor = createDonor("gateway-a");
    setActivePluginRegistry(donor.registry, "gateway-a", "gateway-bindable");
    const registry = loadAndActivateRootPluginRegistry(options);
    const expected = { details: { nodes: ["gateway-a"], messages: ["gateway-a"] } };
    expect(await read(registry)).toMatchObject(expected);
    expect(getActivePluginRegistry()).toBe(registry);
    expect(loadAndActivateRootPluginRegistry(options)).toBe(registry);
    expect(resolveCompatibleRuntimePluginRegistry(options)).toBe(registry);
    expect(await read(registry)).toMatchObject(expected);
    expect(loadPluginModule).not.toHaveBeenCalled();
    return;
  }
  let previous: ReturnType<typeof loadPluginRegistryHandle> | undefined;
  for (const owner of ["gateway-a", "gateway-b"]) {
    const donor = createDonor(owner);
    setActivePluginRegistry(donor.registry, owner, "gateway-bindable");
    const registry = loadPluginRegistryHandle(options);
    expect(donor.reads.nodes).not.toHaveBeenCalled();
    expect(donor.reads.subagent).not.toHaveBeenCalled();
    expect(await read(registry)).toMatchObject({
      details: {
        nodes: [explicit.nodes ? "explicit" : owner],
        messages: [explicit.subagent ? "explicit" : owner],
      },
    });
    expect(donor.reads.nodes.mock.calls.length > 0).toBe(!explicit.nodes);
    expect(donor.reads.subagent.mock.calls.length > 0).toBe(!explicit.subagent);
    expect(loadPluginRegistryHandle(options)).toBe(registry);
    if (previous) {
      expect(registry === previous).toBe(explicit.nodes && explicit.subagent);
    }
    previous = registry;
  }
  expect(loadPluginModule).not.toHaveBeenCalled();
});

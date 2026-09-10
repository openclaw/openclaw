// Discovery must not replace the runtime consumed by an already registered plugin.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { loadAndActivateRootPluginRegistry, loadPluginRegistryHandle } from "./loader.js";
import {
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

afterEach(resetPluginLoaderTestStateForTest);

it("keeps background dispatch on its registration owner after discovery replaces the module slot", async () => {
  useNoBundledPlugins();
  const fixtureKey = Symbol.for("openclaw.test.runtimeStoreFactory");
  const fixtures = globalThis as Record<PropertyKey, unknown>;
  fixtures[fixtureKey] = createPluginRuntimeStore;
  onTestFinished(() => {
    delete fixtures[fixtureKey];
  });
  const plugin = writePlugin({
    id: "runtime-owner",
    // Keep the SDK in Vitest's module graph; native require may select stale dist artifacts.
    body: `const createPluginRuntimeStore = globalThis[Symbol.for("openclaw.test.runtimeStoreFactory")];
      const store = createPluginRuntimeStore({ pluginId: "runtime-owner", errorMessage: "runtime missing" });
      module.exports = { id: "runtime-owner", register(api) {
        store.setRuntime(api.runtime);
        api.registerCli(({ program }) => program.command("dispatch").action(async () => {
          await Promise.resolve();
          await store.getRuntime().gateway.request("owner.probe", {}, { scopes: ["operator.read"] });
        }), { commands: ["dispatch"] });
      } };`,
  });
  const options = {
    cache: false,
    pluginSdkResolution: "src" as const,
    config: {
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        slots: { memory: "none" },
      },
    },
  };
  const calls: string[] = [];
  const gateway = (owner: string): PluginRuntime["gateway"] => ({
    isAvailable: async () => true,
    async request() {
      calls.push(owner);
      throw new Error(`${owner} dispatch`);
    },
  });
  const root = loadAndActivateRootPluginRegistry({
    ...options,
    runtimeOptions: { gateway: gateway("root") },
  });
  const discovered = loadPluginRegistryHandle({
    ...options,
    workspaceDir: path.join(makePluginLoaderTempDir(), "discovery"),
    runtimeOptions: { gateway: gateway("discovery") },
  });
  for (const [registry, owner] of [
    [root, "root"],
    [discovered, "discovery"],
    [{ ...root }, "root"],
  ] as const) {
    expect(registry.plugins[0]?.status).toBe("loaded");
    const program = new Command();
    await registry.cliRegistrars[0]!.register({
      program,
      parentPath: [],
      config: options.config,
      logger: { info() {}, warn() {}, error() {} },
    });
    await expect(
      withPluginRuntimeRegistryScope(registry, () =>
        program.parseAsync(["dispatch"], { from: "user" }),
      ),
    ).rejects.toThrow(`${owner} dispatch`);
  }
  expect(calls).toEqual(["root", "discovery", "root"]);
});

it.each([true, false])("owns setup runtime setters (full runtime setter: %s)", (fullSetter) => {
  useNoBundledPlugins();
  const store = createPluginRuntimeStore<PluginRuntime>({
    pluginId: "setup-owner",
    errorMessage: "setup runtime missing",
  });
  const fixtureKey = Symbol.for("openclaw.test.setupRuntimeStore");
  const fixtures = globalThis as Record<PropertyKey, unknown>;
  fixtures[fixtureKey] = store;
  onTestFinished(() => {
    delete fixtures[fixtureKey];
  });
  const common = `const store = globalThis[Symbol.for("openclaw.test.setupRuntimeStore")];
    const plugin = { id: "setup-owner", meta: { id: "setup-owner", label: "Setup owner", selectionLabel: "Setup owner", docsPath: "/channels/setup-owner", blurb: "fixture" },
      capabilities: { chatTypes: ["direct"] }, config: { listAccountIds: () => [], resolveAccount: () => ({}) } };`;
  const plugin = writePlugin({
    id: "setup-owner",
    filename: "index.cjs",
    body: `${common} module.exports = { id: "setup-owner", kind: "bundled-channel-entry", loadChannelPlugin: () => plugin,
      ${fullSetter ? "setChannelRuntime: store.setRuntime," : ""}
      register(api) { store.setRuntime(api.runtime); api.registerChannel({ plugin }); } };`,
  });
  writeFileSync(
    path.join(plugin.dir, "package.json"),
    JSON.stringify({
      name: plugin.id,
      openclaw: { extensions: ["./index.cjs"], setupEntry: "./setup-entry.cjs" },
    }),
  );
  writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      channels: [plugin.id],
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  );
  writeFileSync(
    path.join(plugin.dir, "setup-entry.cjs"),
    `${common} module.exports = { kind: "bundled-channel-setup-entry", loadSetupPlugin: () => plugin, setChannelRuntime: store.setRuntime };`,
  );
  const options = {
    cache: false,
    config: {
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.dir] },
        entries: { [plugin.id]: { enabled: true } },
        slots: { memory: "none" },
      },
    },
  };
  const root = loadAndActivateRootPluginRegistry(options);
  const rootRuntime = store.getRuntime();
  const setup = loadPluginRegistryHandle({ ...options, channelPluginLoadIntent: "setup" });
  expect(setup.plugins[0]?.status).toBe("loaded");
  expect(setup.channels).toHaveLength(1);
  expect(store.getRuntime() === rootRuntime).toBe(true);
  const setupRuntime = withPluginRuntimeRegistryScope(setup, () => store.getRuntime());
  expect(setupRuntime === rootRuntime).toBe(false);
  expect(withPluginRuntimeRegistryScope(root, () => store.getRuntime()) === rootRuntime).toBe(true);
});

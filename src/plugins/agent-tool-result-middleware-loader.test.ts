import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { createAgentToolResultMiddlewareRunner } from "../agents/harness/tool-result-middleware.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  getAgentToolResultMiddlewareMatcherScope,
  listAgentToolResultMiddlewareRegistrations,
} from "./agent-tool-result-middleware.js";
import { pluginFixtureConfig } from "./loader-fixture-builders.test-support.js";
import { loadPluginRegistryHandle } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

const event = {
  toolName: "exec",
  toolCallId: "scoped-call",
  args: { command: "git status" },
  result: { content: [{ type: "text" as const, text: "raw output" }], details: {} },
};
const run = () =>
  createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }).applyToolResultMiddleware(event);

beforeEach(resetPluginLoaderTestStateForTest);
afterEach(() => {
  resetPluginLoaderTestStateForTest();
  clearRuntimeConfigSnapshot();
});
afterAll(cleanupPluginLoaderFixturesForTest);

async function fixture(runFixture: (root: string) => Promise<void>) {
  const root = makePluginLoaderTempDir();
  await using cache = createPluginCache();
  await withEnvAsync(
    { OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    () => withPluginCache(cache, () => runFixture(root)),
  );
}

function middlewarePlugin(root: string, label: string) {
  const plugin = writePlugin({
    id: "scoped-middleware",
    dir: path.join(root, label),
    body: `let registrations = 0; module.exports = { id: "scoped-middleware", register(api) {
      const registration = ++registrations;
      api.registerAgentToolResultMiddleware(() => ({
        result: { content: [{ type: "text", text: ${JSON.stringify(label)} + ":" + registration }], details: {} },
      }), { runtimes: ["openclaw"], matcher: ["exec"] });
    } };`,
  });
  const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(manifestPath, "utf8")),
      contracts: { agentToolResultMiddleware: ["openclaw"] },
    }),
  );
  return plugin;
}

it.each([false, true])(
  "discovers scoped callbacks and matchers with a process root=%s",
  (hasRoot) =>
    fixture(async (root) => {
      const plugin = middlewarePlugin(root, "scoped");
      const registry = loadPluginRegistryHandle({
        config: pluginFixtureConfig(plugin, { enabled: true }),
        onlyPluginIds: [plugin.id],
        throwOnLoadError: true,
      });
      expect(registry.agentToolResultMiddlewares).toHaveLength(1);
      const processRoot = hasRoot ? createEmptyPluginRegistry() : null;
      if (processRoot) {
        setActivePluginRegistry(processRoot);
      }
      await withPluginRuntimeRegistryScope(registry, async () => {
        expect((await run()).content).toEqual([{ type: "text", text: "scoped:1" }]);
        expect(listAgentToolResultMiddlewareRegistrations("openclaw")).toHaveLength(1);
        expect(getAgentToolResultMiddlewareMatcherScope("openclaw")).toEqual({
          matchAll: false,
          toolNames: ["exec"],
        });
        expect(listAgentToolResultMiddlewareRegistrations("codex")).toEqual([]);
        expect(getActivePluginRegistry()).toBe(processRoot);
      });
    }),
);

it("loads lazy owners from their scoped generation, never a same-id root callback", () =>
  fixture(async (root) => {
    const rootPlugin = middlewarePlugin(root, "root");
    const processRoot = loadPluginRegistryHandle({
      config: pluginFixtureConfig(rootPlugin, { enabled: true }),
      onlyPluginIds: [rootPlugin.id],
      throwOnLoadError: true,
    });
    setActivePluginRegistry(processRoot);
    const plugin = middlewarePlugin(root, "scoped");
    const config = pluginFixtureConfig(plugin, { enabled: true });
    const registry = loadPluginRegistryHandle({
      config,
      onlyPluginIds: [plugin.id],
      loadModules: false,
      throwOnLoadError: true,
    });
    expect(registry.agentToolResultMiddlewares).toEqual([]);
    expect(registry.agentToolResultMiddlewareOwners.map(({ pluginId }) => pluginId)).toEqual([
      plugin.id,
    ]);
    // An admitted generation retains its prepared config even if the process has another one.
    setRuntimeConfigSnapshot({ plugins: { enabled: false } });
    await withPluginRuntimeRegistryScope(registry, async () => {
      expect((await run()).content).toEqual([{ type: "text", text: "scoped:1" }]);
    });
    expect((await run()).content).toEqual([{ type: "text", text: "root:1" }]);
    await withPluginRuntimeRegistryScope(registry, async () => {
      expect((await run()).content).toEqual([{ type: "text", text: "scoped:1" }]);
    });
    expect(getActivePluginRegistry()).toBe(processRoot);
  }));

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  loadOpenClawPlugins,
} from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makeTempDir,
  mkdirSafe,
  EMPTY_PLUGIN_SCHEMA,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "./loader.test-fixtures.js";
import { setSystemPluginsDirOverrideForTest } from "./roots.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  setSystemPluginsDirOverrideForTest(undefined);
});
afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

function writeSystemPlugin(params: {
  id: string;
  body: string;
  systemDir: string;
}) {
  const pluginDir = path.join(params.systemDir, params.id);
  mkdirSafe(pluginDir);
  const file = path.join(pluginDir, "index.cjs");
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({ id: params.id, configSchema: EMPTY_PLUGIN_SCHEMA }),
    "utf-8",
  );
  return { dir: pluginDir, file, id: params.id };
}

function loadRegistryWithSystemPlugin(params: {
  systemDir: string;
  pluginConfig?: Record<string, unknown>;
}) {
  setSystemPluginsDirOverrideForTest(params.systemDir);
  return loadOpenClawPlugins({
    cache: false,
    workspaceDir: makeTempDir(),
    config: {
      plugins: params.pluginConfig ?? {},
    },
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
}

describe("system plugin loader integration", () => {
  it("loads a system plugin and marks it as enabled", () => {
    const systemDir = makeTempDir();
    writeSystemPlugin({
      id: "sys-basic",
      systemDir,
      body: `module.exports = { id: "sys-basic", register(api) {} };`,
    });

    const registry = loadRegistryWithSystemPlugin({ systemDir });
    const plugin = registry.plugins.find((p) => p.id === "sys-basic");
    expect(plugin).toBeDefined();
    expect(plugin!.status).toBe("loaded");
    expect(plugin!.origin).toBe("system");
  });

  it("system plugins load even when plugins.enabled is false", () => {
    const systemDir = makeTempDir();
    writeSystemPlugin({
      id: "sys-survives-disable",
      systemDir,
      body: `module.exports = { id: "sys-survives-disable", register(api) {} };`,
    });

    const registry = loadRegistryWithSystemPlugin({
      systemDir,
      pluginConfig: { enabled: false },
    });
    const plugin = registry.plugins.find((p) => p.id === "sys-survives-disable");
    expect(plugin).toBeDefined();
    expect(plugin!.status).toBe("loaded");
  });

  it("system plugins load even when in the deny list", () => {
    const systemDir = makeTempDir();
    writeSystemPlugin({
      id: "sys-survives-deny",
      systemDir,
      body: `module.exports = { id: "sys-survives-deny", register(api) {} };`,
    });

    const registry = loadRegistryWithSystemPlugin({
      systemDir,
      pluginConfig: { deny: ["sys-survives-deny"] },
    });
    const plugin = registry.plugins.find((p) => p.id === "sys-survives-deny");
    expect(plugin).toBeDefined();
    expect(plugin!.status).toBe("loaded");
  });

  it("system plugins get conversation hooks without explicit allowConversationAccess", () => {
    const systemDir = makeTempDir();
    writeSystemPlugin({
      id: "sys-conversation",
      systemDir,
      body: `module.exports = { id: "sys-conversation", register(api) {
  api.on("llm_input", () => undefined);
  api.on("llm_output", () => undefined);
  api.on("before_agent_finalize", () => undefined);
  api.on("agent_end", () => undefined);
} };`,
    });

    const registry = loadRegistryWithSystemPlugin({ systemDir });
    const hookNames = registry.typedHooks
      .filter((h) => h.pluginId === "sys-conversation")
      .map((h) => h.hookName);
    expect(hookNames).toEqual([
      "llm_input",
      "llm_output",
      "before_agent_finalize",
      "agent_end",
    ]);
  });

  it("system plugins get prompt injection hooks without explicit allowPromptInjection", () => {
    const systemDir = makeTempDir();
    writeSystemPlugin({
      id: "sys-prompt",
      systemDir,
      body: `module.exports = { id: "sys-prompt", register(api) {
  api.on("before_prompt_build", () => ({ prependContext: "system policy" }));
  api.on("before_agent_start", () => ({ prependContext: "legacy" }));
} };`,
    });

    const registry = loadRegistryWithSystemPlugin({ systemDir });
    const hookNames = registry.typedHooks
      .filter((h) => h.pluginId === "sys-prompt")
      .map((h) => h.hookName);
    expect(hookNames).toEqual(["before_prompt_build", "before_agent_start"]);
    const blockedDiags = registry.diagnostics.filter(
      (d) => d.pluginId === "sys-prompt" && d.message.includes("blocked"),
    );
    expect(blockedDiags).toHaveLength(0);
  });

  it("system plugin hooks get priority >= 10000", () => {
    const systemDir = makeTempDir();
    writeSystemPlugin({
      id: "sys-priority",
      systemDir,
      body: `module.exports = { id: "sys-priority", register(api) {
  api.on("before_tool_call", () => ({ block: false }));
  api.on("before_model_resolve", () => ({}), { priority: 50 });
} };`,
    });

    const registry = loadRegistryWithSystemPlugin({ systemDir });
    const hooks = registry.typedHooks.filter((h) => h.pluginId === "sys-priority");
    expect(hooks).toHaveLength(2);
    for (const hook of hooks) {
      expect(hook.priority).toBeGreaterThanOrEqual(10000);
    }
  });

  it("system plugin hooks run before non-system plugin hooks", async () => {
    useNoBundledPlugins();
    const systemDir = makeTempDir();
    setSystemPluginsDirOverrideForTest(systemDir);
    writeSystemPlugin({
      id: "sys-first",
      systemDir,
      body: `module.exports = { id: "sys-first", register(api) {
  api.on("before_model_resolve", () => ({ providerOverride: "system-provider" }));
} };`,
    });

    const userPluginDir = makeTempDir();
    mkdirSafe(userPluginDir);
    fs.writeFileSync(
      path.join(userPluginDir, "index.cjs"),
      `module.exports = { id: "user-plugin", register(api) {
  api.on("before_model_resolve", () => ({ providerOverride: "user-provider" }), { priority: 999 });
} };`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(userPluginDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "user-plugin", configSchema: EMPTY_PLUGIN_SCHEMA }),
      "utf-8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: makeTempDir(),
      config: {
        plugins: {
          load: { paths: [path.join(userPluginDir, "index.cjs")] },
          allow: ["user-plugin"],
        },
      },
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });

    const sysHook = registry.typedHooks.find((h) => h.pluginId === "sys-first");
    const userHook = registry.typedHooks.find((h) => h.pluginId === "user-plugin");
    expect(sysHook).toBeDefined();
    expect(userHook).toBeDefined();
    expect((sysHook!.priority ?? 0)).toBeGreaterThan(userHook!.priority ?? 0);
  });
});

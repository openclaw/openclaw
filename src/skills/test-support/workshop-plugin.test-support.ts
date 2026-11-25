import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { shareVitestModuleGraphWithBundledPlugin } from "../../plugins/test-helpers/vitest-plugin-host-graph.js";

/** The config with the bundled skill-workshop plugin enabled; Vitest runs with plugins off. */
function withWorkshopPlugin(config: OpenClawConfig = {}): OpenClawConfig {
  const allow = config.plugins?.allow;
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      ...(allow ? { allow: [...new Set([...allow, "skill-workshop"])] } : {}),
    },
  };
}

/**
 * Gives the skill-workshop plugin the real loader or an in-process Gateway loads this test's
 * core module graph and its checkout source. Returns the restore, so `beforeAll` can take it.
 */
export async function shareCoreWithWorkshopPluginForTest(): Promise<() => void> {
  return await shareVitestModuleGraphWithBundledPlugin("skill-workshop");
}

/**
 * Loads and activates the bundled skill-workshop plugin through the real loader, so its tool,
 * prompt guidance, hooks, /learn contribution, CLI and Gateway methods serve the test like a
 * Gateway's startup load does. Call the returned reset in afterEach/afterAll.
 */
export async function activateWorkshopPluginForTest(config: OpenClawConfig = {}): Promise<{
  registry: PluginRegistry;
  reset: () => void;
}> {
  const restoreBundledDir = await shareCoreWithWorkshopPluginForTest();
  const registry = loadOpenClawPlugins({
    config: withWorkshopPlugin(config),
    onlyPluginIds: ["skill-workshop"],
    cache: false,
    activate: true,
  });
  const record = registry.plugins.find((plugin) => plugin.id === "skill-workshop");
  if (record?.status !== "loaded") {
    throw new Error(
      `skill-workshop did not load: ${record?.status ?? "missing"} ${record?.error ?? ""}`,
    );
  }
  return {
    registry,
    reset: () => {
      resetPluginRuntimeStateForTest();
      restoreBundledDir();
    },
  };
}

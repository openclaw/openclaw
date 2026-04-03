import { describe, expect, it } from "vitest";
import { bundledPluginRoot } from "../../test/helpers/bundled-plugin-paths.js";
import tsdownConfig from "../../tsdown.config.ts";

type TsdownConfigEntry = {
  deps?: {
    neverBundle?: string[];
  };
  entry?: Record<string, string> | string[];
  outDir?: string;
};

function asConfigArray(config: unknown): TsdownConfigEntry[] {
  return Array.isArray(config) ? (config as TsdownConfigEntry[]) : [config as TsdownConfigEntry];
}

function entryKeys(config: TsdownConfigEntry): string[] {
  if (!config.entry || Array.isArray(config.entry)) {
    return [];
  }
  return Object.keys(config.entry);
}

function bundledEntry(pluginId: string): string {
  return `${bundledPluginRoot(pluginId)}/index`;
}

describe("tsdown config", () => {
  it("keeps core, plugin runtime, plugin-sdk, bundled plugins, and bundled hooks in one dist graph", () => {
    const configs = asConfigArray(tsdownConfig);
    const distGraphs = configs.filter((config) => {
      const keys = entryKeys(config);
      return (
        keys.includes("index") ||
        keys.includes("plugins/runtime/index") ||
        keys.includes("plugin-sdk/index") ||
        keys.includes(bundledEntry("openai")) ||
        keys.includes("bundled/boot-md/handler")
      );
    });

    expect(distGraphs).toHaveLength(1);
    expect(entryKeys(distGraphs[0])).toEqual(
      expect.arrayContaining([
        "agents/auth-profiles.runtime",
        "agents/pi-model-discovery-runtime",
        "index",
        "commands/status.summary.runtime",
        "plugins/provider-runtime.runtime",
        "plugins/runtime/runtime-line.contract",
        "plugins/runtime/index",
        "plugin-sdk/compat",
        "plugin-sdk/index",
        bundledEntry("openai"),
        bundledEntry("matrix"),
        bundledEntry("msteams"),
        bundledEntry("whatsapp"),
        "bundled/boot-md/handler",
      ]),
    );
  });

  it("does not emit plugin-sdk or hooks from a separate dist graph", () => {
    const configs = asConfigArray(tsdownConfig);

    expect(configs.some((config) => config.outDir === "dist/plugin-sdk")).toBe(false);
    expect(
      configs.some((config) =>
        Array.isArray(config.entry)
          ? config.entry.some((entry) => entry.includes("src/hooks/"))
          : false,
      ),
    ).toBe(false);
  });

  it("externalizes staged bundled plugin runtime dependencies", () => {
    const configs = asConfigArray(tsdownConfig);
    const unifiedGraph = configs.find((config) => entryKeys(config).includes("index"));

    expect(unifiedGraph?.deps?.neverBundle).toEqual(expect.arrayContaining(["silk-wasm", "ws"]));
  });
});

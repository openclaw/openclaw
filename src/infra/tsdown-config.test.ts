import { describe, expect, it } from "vitest";
import tsdownConfig from "../../tsdown.config.ts";

type TsdownConfigEntry = {
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

describe("tsdown config", () => {
  it("keeps core, plugin runtime, plugin-sdk, bundled plugins, and bundled hooks in one dist graph", () => {
    const configs = asConfigArray(tsdownConfig);
    const distGraphs = configs.filter((config) => {
      const keys = entryKeys(config);
      return (
        keys.includes("index") ||
        keys.includes("plugins/runtime/index") ||
        keys.includes("plugin-sdk/index") ||
        keys.includes("extensions/openai/index") ||
        keys.includes("bundled/boot-md/handler")
      );
    });

    expect(distGraphs).toHaveLength(1);
    expect(entryKeys(distGraphs[0])).toEqual(
      expect.arrayContaining([
        "agents/auth-profiles.runtime",
        "agents/pi-model-discovery-runtime",
        "index",
        "cli/memory-cli",
        "commands/status.summary.runtime",
        "plugins/provider-runtime.runtime",
        "plugins/runtime/index",
        "plugin-sdk/compat",
        "plugin-sdk/index",
        "extensions/openai/index",
        "extensions/matrix/index",
        "extensions/msteams/index",
        "extensions/whatsapp/index",
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
});

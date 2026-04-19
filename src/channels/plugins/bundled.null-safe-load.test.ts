import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";

const tempDirs: string[] = [];
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  vi.resetModules();
  vi.doUnmock("../../plugins/bundled-channel-runtime.js");
  vi.doUnmock("../../plugins/bundled-plugin-metadata.js");
  vi.doUnmock("../../plugins/manifest-registry.js");
  vi.doUnmock("../../plugins/channel-catalog-registry.js");
});

/**
 * Regression coverage for the 2026-04-19 `openclaw cron --help` crash:
 * a bundled channel plugin module whose `loadChannelPlugin()` returns
 * undefined (malformed / legacy plugin shape) used to produce
 *   TypeError: Cannot read properties of undefined (reading 'id')
 * deep inside `getBundledChannelPluginForRoot` → `normalizeChannelMeta`,
 * surfaced as a noisy stack on `openclaw cron --help`, `openclaw cron list`,
 * and any other command path that reads config through the legacy-config
 * migration helpers.
 *
 * The fix null-checks the `loadChannelPlugin()` result and returns undefined
 * instead of crashing. Callers already treat an undefined plugin as "not
 * available", so this degrades gracefully rather than poisoning the command.
 */
describe("bundled channel plugin loader handles undefined loadChannelPlugin()", () => {
  it("returns undefined instead of throwing when loadChannelPlugin yields undefined", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-null-safe-load-"));
    tempDirs.push(root);
    const pluginsDir = path.join(root, "dist", "extensions");
    const pluginDir = path.join(pluginsDir, "brokenchan");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      [
        "export default {",
        "  kind: 'bundled-channel-entry',",
        "  id: 'brokenchan',",
        "  name: 'Broken channel',",
        "  description: 'A channel whose plugin factory returns undefined',",
        "  register() {},",
        "  loadChannelPlugin() {",
        "    // Simulates a legacy/misshapen plugin module whose default export",
        "    // is not actually a ChannelPlugin. Runtime-reachable in the wild.",
        "    return undefined;",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    vi.doMock("../../plugins/channel-catalog-registry.js", () => ({
      listChannelCatalogEntries: (params?: { env?: NodeJS.ProcessEnv }) => {
        const activeRoot = params?.env?.OPENCLAW_BUNDLED_PLUGINS_DIR;
        if (activeRoot === pluginsDir) {
          return [{ pluginId: "brokenchan" }];
        }
        return [];
      },
    }));

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = pluginsDir;

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=null-safe-load",
    );

    // Must NOT throw. Must return undefined, letting callers degrade.
    let result: unknown;
    expect(() => {
      result = bundled.getBundledChannelPlugin("brokenchan" as never);
    }).not.toThrow();
    expect(result).toBeUndefined();
  });
});

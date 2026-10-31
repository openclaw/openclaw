import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { formatPluginLine } from "../cli/plugins-list-format.js";
import { pluginFixtureConfig, writeFixtureJson } from "./loader-fixture-builders.test-support.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  writePluginMetadata,
} from "./loader.test-fixtures.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";

vi.unmock("../version.js");
afterEach(() => {
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

const hostVersion = "2026.10.2";

it.each([
  ["below-floor official runtime", "@openclaw/codex", "2026.9.6", true],
  ["official runtime at the compatibility floor", "@openclaw/codex", "2026.9.7", false],
  ["compatible official runtime older than the host", "@openclaw/codex", "2026.10.1", false],
  ["matching official runtime", "@openclaw/codex", hostVersion, false],
  ["newer official runtime", "@openclaw/codex", "2099.1.1", false],
  ["independent runtime", "@example/codex", "2026.9.5", false],
] as const)(
  "admits %s according to its release owner",
  async (_name, packageName, version, incompatible) => {
    useNoBundledPlugins();
    vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", hostVersion);
    const plugin = writePlugin({
      id: "codex",
      filename: "index.cjs",
      registration: `api.registerTool({ name: "runtime_probe", description: "Probe", parameters: { type: "object", properties: {} }, execute: async () => (await import("./runtime.mjs")).result });`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "runtime.mjs"),
      `${incompatible ? 'import "openclaw/plugin-sdk/agent-harness-task-runtime";' : ""}
export const result = { content: [{ type: "text", text: "runtime ready" }] };`,
    );
    writePluginMetadata({
      ...plugin,
      packageJson: {
        name: packageName,
        version,
        openclaw: { extensions: ["./index.cjs"], compat: { pluginApi: ">=2026.9.5" } },
      },
    });
    const manifestFile = path.join(plugin.dir, "openclaw.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    writeFixtureJson(plugin.dir, "openclaw.plugin.json", {
      ...manifest,
      contracts: { tools: ["runtime_probe"] },
    });
    const config = pluginFixtureConfig({ id: plugin.id, file: plugin.dir });
    const registry = loadOpenClawPlugins({
      config,
      manifestRegistry: loadPluginManifestRegistryCore({ config, installRecords: {} }),
      installRecords: {},
      cache: false,
      runtimeSideEffects: true,
    });
    const record = registry.plugins.find((entry) => entry.id === plugin.id);
    expect(record?.status).toBe(incompatible ? "error" : "loaded");
    if (incompatible) {
      expect(registry.tools).toHaveLength(0);
      expect(record?.activated).toBe(false);
      expect(record?.error).toContain(version);
      expect(record?.error).toContain(hostVersion);
      expect(record?.error).toContain("minimum compatible plugin version is 2026.9.7");
      expect(record?.error).toContain("openclaw update repair");
      expect(formatPluginLine(record!)).toContain("openclaw plugins update codex");
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({ pluginId: "codex", level: "error", message: record?.error }),
      );
    } else {
      expect(registry.tools.map((tool) => tool.names)).toEqual([["runtime_probe"]]);
      const tool = registry.tools[0]?.factory({});
      if (!tool || Array.isArray(tool)) {
        throw new Error("Expected the runtime probe tool");
      }
      expect(await tool.execute("probe", {})).toMatchObject({
        content: [{ type: "text", text: "runtime ready" }],
      });
    }
  },
);

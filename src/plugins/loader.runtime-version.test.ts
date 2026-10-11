import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { formatPluginLine } from "../cli/plugins-list-format.js";
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
  {
    name: "below-floor official runtime",
    packageName: "@openclaw/codex",
    version: "2026.9.6",
    incompatible: true,
  },
  {
    name: "official runtime at the compatibility floor",
    packageName: "@openclaw/codex",
    version: "2026.9.7",
    incompatible: false,
  },
  {
    name: "compatible official runtime older than the host",
    packageName: "@openclaw/codex",
    version: "2026.10.1",
    incompatible: false,
  },
  {
    name: "matching official runtime",
    packageName: "@openclaw/codex",
    version: hostVersion,
    incompatible: false,
  },
  {
    name: "newer official runtime",
    packageName: "@openclaw/codex",
    version: "2099.1.1",
    incompatible: false,
  },
  {
    name: "independent runtime",
    packageName: "@example/codex",
    version: "2026.9.5",
    incompatible: false,
  },
])(
  "admits $name according to its release owner",
  async ({ packageName, version, incompatible }) => {
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
      dir: plugin.dir,
      id: plugin.id,
      packageJson: {
        name: packageName,
        version,
        openclaw: { extensions: ["./index.cjs"], compat: { pluginApi: ">=2026.9.5" } },
      },
    });
    const manifestFile = path.join(plugin.dir, "openclaw.plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({ ...manifest, contracts: { tools: ["runtime_probe"] } }),
    );
    const config = {
      plugins: { allow: [plugin.id], load: { paths: [plugin.dir] }, slots: { memory: "none" } },
    };
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

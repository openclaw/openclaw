import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildVitestCapabilityShimAliasMap,
  loadBundledCapabilityRuntimeRegistry,
} from "./bundled-capability-runtime.js";
import type { PluginDiscoveryResult } from "./discovery.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeBundledRuntimePlugin(params: {
  pluginId: string;
  body: string;
  contracts?: { tools?: string[] };
}): PluginDiscoveryResult {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-capability-"));
  tempDirs.push(rootDir);
  const source = path.join(rootDir, "index.cjs");
  const manifestPath = path.join(rootDir, "openclaw.plugin.json");
  const manifest = {
    id: params.pluginId,
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    contracts: params.contracts,
  };
  fs.writeFileSync(source, params.body, "utf-8");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  return {
    candidates: [
      {
        idHint: params.pluginId,
        source,
        rootDir,
        origin: "bundled",
        bundledManifest: manifest,
        bundledManifestPath: manifestPath,
      },
    ],
    diagnostics: [],
  };
}

describe("buildVitestCapabilityShimAliasMap", () => {
  it("keeps scoped and unscoped capability shim aliases aligned", () => {
    const aliasMap = buildVitestCapabilityShimAliasMap();

    expect(aliasMap["openclaw/plugin-sdk/config-runtime"]).toBe(
      aliasMap["@openclaw/plugin-sdk/config-runtime"],
    );
    expect(aliasMap["openclaw/plugin-sdk/media-runtime"]).toBe(
      aliasMap["@openclaw/plugin-sdk/media-runtime"],
    );
    expect(aliasMap["openclaw/plugin-sdk/provider-onboard"]).toBe(
      aliasMap["@openclaw/plugin-sdk/provider-onboard"],
    );
    expect(aliasMap["openclaw/plugin-sdk/speech-core"]).toBe(
      aliasMap["@openclaw/plugin-sdk/speech-core"],
    );
  });
});

describe("loadBundledCapabilityRuntimeRegistry", () => {
  it("skips unreadable captured tool names without dropping healthy siblings", () => {
    const pluginId = "bundled-bad-tool-name";
    const discovery = writeBundledRuntimePlugin({
      pluginId,
      contracts: { tools: ["healthy_tool"] },
      body: `
module.exports = {
  register(api) {
    api.registerTool(Object.defineProperty({
      label: "Bad",
      description: "Bad",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => ({ content: [] }),
    }, "name", {
      get() {
        throw new Error("name unavailable");
      },
    }));
    api.registerTool({
      name: "healthy_tool",
      label: "Healthy",
      description: "Healthy",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => ({ content: [] }),
    });
  },
};
`,
    });

    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: [pluginId],
      discovery,
      env: {
        ...process.env,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });

    expect(registry.plugins).toMatchObject([
      {
        id: pluginId,
        status: "loaded",
        toolNames: ["healthy_tool"],
      },
    ]);
    expect(registry.tools.map((entry) => entry.names)).toEqual([["healthy_tool"]]);
    expect(registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          pluginId,
          message: "plugin tool registration missing readable name: name unavailable",
        }),
      ]),
    );
    expect(registry.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("failed to load plugin"),
        }),
      ]),
    );
  });
});

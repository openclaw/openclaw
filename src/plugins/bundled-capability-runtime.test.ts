import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildVitestCapabilityShimAliasMap,
  loadBundledCapabilityRuntimeRegistry,
} from "./bundled-capability-runtime.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createBundledCapabilityToolPlugin(params: {
  id: string;
  toolName: string;
  contractsTools?: string[];
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-capability-plugin-"));
  tempRoots.push(root);
  const extensionsRoot = path.join(root, "extensions");
  const pluginRoot = path.join(extensionsRoot, params.id);
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: params.id,
        configSchema: {
          type: "object",
          additionalProperties: true,
        },
        ...(params.contractsTools
          ? {
              contracts: {
                tools: params.contractsTools,
              },
            }
          : {}),
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(pluginRoot, "index.js"),
    `module.exports = {
  register(api) {
    api.registerTool({
      name: ${JSON.stringify(params.toolName)},
      description: "test capability tool",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ text: "ok" }),
    });
  },
};
`,
  );
  return extensionsRoot;
}

function loadFixtureCapabilityRegistry(params: { pluginId: string; extensionsRoot: string }) {
  return loadBundledCapabilityRuntimeRegistry({
    pluginIds: [params.pluginId],
    env: {
      ...process.env,
      VITEST: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: params.extensionsRoot,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    },
  });
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
  it("propagates manifest tool contracts to bundled capability tool validation", () => {
    const pluginId = "capability-tool-contract";
    const toolName = "capability_tool";
    const extensionsRoot = createBundledCapabilityToolPlugin({
      id: pluginId,
      toolName,
      contractsTools: [toolName],
    });

    const registry = loadFixtureCapabilityRegistry({ pluginId, extensionsRoot });

    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]?.contracts?.tools).toEqual([toolName]);
    expect(registry.tools.flatMap((tool) => tool.names)).toContain(toolName);
    expect(registry.diagnostics.map((entry) => entry.message)).not.toContain(
      `plugin must declare contracts.tools for: ${toolName}`,
    );
  });

  it("still rejects bundled capability tools missing manifest contracts", () => {
    const pluginId = "capability-tool-missing-contract";
    const toolName = "undeclared_capability_tool";
    const extensionsRoot = createBundledCapabilityToolPlugin({
      id: pluginId,
      toolName,
    });

    const registry = loadFixtureCapabilityRegistry({ pluginId, extensionsRoot });

    expect(registry.tools.flatMap((tool) => tool.names)).not.toContain(toolName);
    expect(registry.diagnostics.map((entry) => entry.message)).toContain(
      `plugin must declare contracts.tools for: ${toolName}`,
    );
  });
});

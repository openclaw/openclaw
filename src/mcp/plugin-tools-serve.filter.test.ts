import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquirePluginToolsForMcp } from "./plugin-tools-serve.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFixturePlugin(params: {
  rootDir: string;
  id: string;
  toolName: string;
  optional?: boolean;
  markerFile?: string;
}): string {
  const pluginDir = path.join(params.rootDir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.id,
      name: params.id,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      contracts: { tools: [params.toolName] },
      ...(params.optional ? { toolMetadata: { [params.toolName]: { optional: true } } } : {}),
    }),
  );
  const markerSnippet = params.markerFile
    ? `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(params.markerFile)}, "loaded");\n`
    : "";
  fs.writeFileSync(
    path.join(pluginDir, "index.mjs"),
    `${markerSnippet}export default {
  id: ${JSON.stringify(params.id)},
  register(api) {
    api.registerTool(
      {
        name: ${JSON.stringify(params.toolName)},
        description: "fixture tool",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
      ${params.optional ? "{ optional: true }" : "{}"},
    );
  },
};
`,
  );
  return pluginDir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin-tools-serve bridge filter real-registry invariants", () => {
  it("never grants an optional plugin tool via bridgePolicy.allow unless base policy already authorizes it", async () => {
    const stateDir = makeTempDir("oc-bridge-opt-state-");
    const pluginsRoot = makeTempDir("oc-bridge-opt-plugins-");
    const alphaDir = writeFixturePlugin({
      rootDir: pluginsRoot,
      id: "fixture-alpha",
      toolName: "fixture_alpha_tool",
    });
    const optDir = writeFixturePlugin({
      rootDir: pluginsRoot,
      id: "fixture-opt",
      toolName: "fixture_opt_tool",
      optional: true,
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", "agent:main:acp:opt-invariant");

    const baseConfig: OpenClawConfig = {
      plugins: {
        enabled: true,
        allow: ["fixture-alpha", "fixture-opt"],
        load: { paths: [alphaDir, optDir] },
        entries: {
          "fixture-alpha": { enabled: true },
          "fixture-opt": { enabled: true },
        },
      },
    };

    const unfiltered = await acquirePluginToolsForMcp({ config: baseConfig });
    try {
      expect(unfiltered.resolveTools().map((tool) => tool.name)).toEqual(["fixture_alpha_tool"]);
    } finally {
      await unfiltered.release();
    }

    const filteredWithoutBaseGrant = await acquirePluginToolsForMcp({
      config: baseConfig,
      bridgePolicy: { allow: ["fixture-alpha", "fixture-opt"] },
    });
    try {
      expect(filteredWithoutBaseGrant.resolveTools().map((tool) => tool.name)).toEqual([
        "fixture_alpha_tool",
      ]);
    } finally {
      await filteredWithoutBaseGrant.release();
    }

    const filteredWithBaseGrant = await acquirePluginToolsForMcp({
      config: {
        ...baseConfig,
        tools: { alsoAllow: ["fixture-opt"] },
      },
      bridgePolicy: { allow: ["fixture-opt"] },
    });
    try {
      expect(filteredWithBaseGrant.resolveTools().map((tool) => tool.name)).toEqual([
        "fixture_opt_tool",
      ]);
    } finally {
      await filteredWithBaseGrant.release();
    }
  });

  it("skips importing modules excluded by base policy or restrictive profile before standalone loading", async () => {
    const stateDir = makeTempDir("oc-bridge-preload-state-");
    const pluginsRoot = makeTempDir("oc-bridge-preload-plugins-");
    const poisonMarker = path.join(stateDir, "poison-imported.flag");
    const alphaDir = writeFixturePlugin({
      rootDir: pluginsRoot,
      id: "fixture-alpha",
      toolName: "fixture_alpha_tool",
    });
    const poisonDir = writeFixturePlugin({
      rootDir: pluginsRoot,
      id: "fixture-poison",
      toolName: "fixture_poison_tool",
      markerFile: poisonMarker,
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", "agent:main:acp:preload-check");

    const basePlugins: OpenClawConfig["plugins"] = {
      enabled: true,
      allow: ["fixture-alpha", "fixture-poison"],
      load: { paths: [alphaDir, poisonDir] },
      entries: {
        "fixture-alpha": { enabled: true },
        "fixture-poison": { enabled: true },
      },
    };

    // With no base narrowing, the bridge alone must exclude the marker plugin before import.
    const bridgeOnly = await acquirePluginToolsForMcp({
      config: { plugins: basePlugins },
      bridgePolicy: { allow: ["fixture_alpha_tool"] },
    });
    try {
      expect(bridgeOnly.resolveTools().map((tool) => tool.name)).toEqual(["fixture_alpha_tool"]);
      expect(fs.existsSync(poisonMarker)).toBe(false);
    } finally {
      await bridgeOnly.release();
    }

    // Base allowlist permits only fixture-alpha (by plugin ID), bridge narrows to tool name + fixture-poison.
    // fixture-poison must NEVER be imported, while cross-representation matching still exposes fixture_alpha_tool.
    const narrowed = await acquirePluginToolsForMcp({
      config: {
        plugins: basePlugins,
        tools: { allow: ["fixture-alpha"] },
      },
      bridgePolicy: { allow: ["fixture_alpha_tool", "fixture-poison"] },
    });
    try {
      expect(narrowed.resolveTools().map((tool) => tool.name)).toEqual(["fixture_alpha_tool"]);
      expect(fs.existsSync(poisonMarker)).toBe(false);
    } finally {
      await narrowed.release();
    }

    // Restrictive minimal profile exposes no plugin tools; bridgePolicy.allow must not import fixture-poison.
    const minimal = await acquirePluginToolsForMcp({
      config: {
        plugins: basePlugins,
        tools: { profile: "minimal" },
      },
      bridgePolicy: { allow: ["fixture-poison"] },
    });
    try {
      expect(minimal.resolveTools()).toEqual([]);
      expect(fs.existsSync(poisonMarker)).toBe(false);
    } finally {
      await minimal.release();
    }
  });
});

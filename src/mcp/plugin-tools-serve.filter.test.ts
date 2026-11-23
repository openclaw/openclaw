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
  optional?: boolean;
  markerFile?: string;
}): string {
  const toolName = `${params.id.replaceAll("-", "_")}_tool`;
  const pluginDir = path.join(params.rootDir, params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.id,
      name: params.id,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      contracts: { tools: [toolName] },
      ...(params.optional ? { toolMetadata: { [toolName]: { optional: true } } } : {}),
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
        api.registerTool({
          name: ${JSON.stringify(toolName)},
          description: "fixture tool",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }] }; },
        }, { optional: ${params.optional === true} });
      },
    };`,
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
    });
    const optDir = writeFixturePlugin({
      rootDir: pluginsRoot,
      id: "fixture-opt",
      optional: true,
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", "agent:main:acp:opt-invariant");

    const baseConfig: OpenClawConfig = {
      plugins: {
        enabled: true,
        allow: ["fixture-alpha", "fixture-opt"],
        load: { paths: [alphaDir, optDir] },
        entries: { "fixture-alpha": { enabled: true }, "fixture-opt": { enabled: true } },
      },
    };

    for (const [config, bridgePolicy, expected] of [
      [baseConfig, undefined, "fixture_alpha_tool"],
      [baseConfig, { allow: ["fixture-alpha", "fixture-opt"] }, "fixture_alpha_tool"],
      [
        { ...baseConfig, tools: { alsoAllow: ["fixture-opt"] } },
        { allow: ["fixture-opt"] },
        "fixture_opt_tool",
      ],
    ] satisfies [OpenClawConfig, { allow: string[] } | undefined, string][]) {
      const acquisition = await acquirePluginToolsForMcp({ config, bridgePolicy });
      try {
        expect(acquisition.resolveTools().map((tool) => tool.name)).toEqual([expected]);
      } finally {
        await acquisition.release();
      }
    }
  });

  it("skips importing modules excluded by base policy or restrictive profile before standalone loading", async () => {
    const stateDir = makeTempDir("oc-bridge-preload-state-");
    const pluginsRoot = makeTempDir("oc-bridge-preload-plugins-");
    const poisonMarker = path.join(stateDir, "poison-imported.flag");
    const alphaDir = writeFixturePlugin({
      rootDir: pluginsRoot,
      id: "fixture-alpha",
    });
    const poisonDir = writeFixturePlugin({
      rootDir: pluginsRoot,
      id: "fixture-poison",
      markerFile: poisonMarker,
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", "agent:main:acp:preload-check");

    const basePlugins: OpenClawConfig["plugins"] = {
      enabled: true,
      allow: ["fixture-alpha", "fixture-poison"],
      load: { paths: [alphaDir, poisonDir] },
      entries: { "fixture-alpha": { enabled: true }, "fixture-poison": { enabled: true } },
    };

    // Bridge narrowing, base allowlist, and minimal profile must all avoid poison imports.
    for (const [tools, allow, expected] of [
      [undefined, ["fixture_alpha_tool"], ["fixture_alpha_tool"]],
      [
        { allow: ["fixture-alpha"] },
        ["fixture_alpha_tool", "fixture-poison"],
        ["fixture_alpha_tool"],
      ],
      [{ profile: "minimal" }, ["fixture-poison"], []],
    ] satisfies [OpenClawConfig["tools"], string[], string[]][]) {
      const acquisition = await acquirePluginToolsForMcp({
        config: { plugins: basePlugins, tools },
        bridgePolicy: { allow },
      });
      try {
        expect(acquisition.resolveTools().map((tool) => tool.name)).toEqual(expected);
        expect(fs.existsSync(poisonMarker)).toBe(false);
      } finally {
        await acquisition.release();
      }
    }
  });
});

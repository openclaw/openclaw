import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listBundledPluginMetadata } from "./bundled-plugin-metadata.js";
import {
  createGeneratedPluginTempRoot,
  installGeneratedPluginTempRootCleanup,
  writeJson,
} from "./generated-plugin-test-helpers.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

installGeneratedPluginTempRootCleanup();

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

function writePlugin(
  rootDir: string,
  params: {
    manifest?: Record<string, unknown>;
    packageOpenClaw?: Record<string, unknown>;
    entrypoint?: "index.ts" | "index.js";
  } = {},
) {
  const pluginDir = path.join(rootDir, "extensions", "alpha");
  writeJson(path.join(pluginDir, "package.json"), {
    name: "@openclaw/alpha",
    version: "0.0.1",
    openclaw: { extensions: ["./index.ts"], ...params.packageOpenClaw },
  });
  writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id: "alpha",
    configSchema: { type: "object" },
    ...params.manifest,
  });
  fs.writeFileSync(path.join(pluginDir, params.entrypoint ?? "index.ts"), "export {};\n", "utf8");
  return pluginDir;
}

describe("bundled plugin public surfaces", () => {
  it("merges runtime channel schema metadata with manifest-owned channel config fields", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-channel-configs-");

    const pluginDir = writePlugin(tempRoot, {
      packageOpenClaw: {
        channel: {
          id: "alpha",
          label: "Alpha Root Label",
          blurb: "Alpha Root Description",
          preferOver: ["alpha-legacy"],
        },
      },
      manifest: {
        channels: ["alpha"],
        channelConfigs: {
          alpha: {
            schema: { type: "object", properties: { stale: { type: "boolean" } } },
            label: "Manifest Label",
            uiHints: { "channels.alpha.explicitOnly": { help: "manifest hint" } },
          },
        },
      },
    });
    fs.mkdirSync(path.join(pluginDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "src", "config-schema.js"),
      [
        "export const AlphaChannelConfigSchema = {",
        "  schema: {",
        "    type: 'object',",
        "    properties: { generated: { type: 'string' } },",
        "  },",
        "  uiHints: {",
        "    'channels.alpha.generatedOnly': { help: 'generated hint' },",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const entries = listBundledPluginMetadata({ rootDir: tempRoot });
    const channelConfigs = entries[0]?.manifest.channelConfigs as
      | Record<string, unknown>
      | undefined;
    expect(channelConfigs?.alpha).toEqual({
      schema: {
        type: "object",
        properties: {
          generated: { type: "string" },
        },
      },
      label: "Manifest Label",
      description: "Alpha Root Description",
      preferOver: ["alpha-legacy"],
      uiHints: {
        "channels.alpha.generatedOnly": { help: "generated hint" },
        "channels.alpha.explicitOnly": { help: "manifest hint" },
      },
    });
  });

  it("captures top-level public surface artifacts without duplicating the primary entrypoints", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-public-artifacts-");

    const pluginDir = writePlugin(tempRoot, {
      packageOpenClaw: { setupEntry: "./setup-entry.ts" },
    });
    for (const filename of ["setup-entry.ts", "api.ts", "runtime-api.ts"]) {
      fs.writeFileSync(path.join(pluginDir, filename), "export {};\n", "utf8");
    }
    const entries = listBundledPluginMetadata({ rootDir: tempRoot });
    const firstEntry = entries[0] as
      | {
          publicSurfaceArtifacts?: string[];
          runtimeSidecarArtifacts?: string[];
        }
      | undefined;
    expect(firstEntry?.publicSurfaceArtifacts).toEqual(["api.js", "runtime-api.js"]);
    expect(firstEntry?.runtimeSidecarArtifacts).toEqual(["runtime-api.js"]);
  });

  it("loads channel config metadata from built public surfaces in dist-only roots", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-dist-config-");
    const distRoot = path.join(tempRoot, "dist");

    const pluginDir = writePlugin(distRoot, {
      entrypoint: "index.js",
      packageOpenClaw: {
        channel: { id: "alpha", label: "Alpha Root Label", blurb: "Alpha Root Description" },
      },
      manifest: {
        configSchema: { type: "object", properties: {} },
        channels: ["alpha"],
        channelConfigs: {
          alpha: {
            schema: { type: "object", properties: { stale: { type: "boolean" } } },
            uiHints: { "channels.alpha.explicitOnly": { help: "manifest hint" } },
          },
        },
      },
    });
    fs.writeFileSync(
      path.join(pluginDir, "channel-config-api.js"),
      [
        "export const AlphaChannelConfigSchema = {",
        "  schema: {",
        "    type: 'object',",
        "    properties: { built: { type: 'string' } },",
        "  },",
        "  uiHints: {",
        "    'channels.alpha.generatedOnly': { help: 'built hint' },",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const entries = listBundledPluginMetadata({ rootDir: distRoot });
    const channelConfigs = entries[0]?.manifest.channelConfigs as
      | Record<string, unknown>
      | undefined;
    expect(channelConfigs?.alpha).toEqual({
      schema: {
        type: "object",
        properties: {
          built: { type: "string" },
        },
      },
      label: "Alpha Root Label",
      description: "Alpha Root Description",
      uiHints: {
        "channels.alpha.generatedOnly": { help: "built hint" },
        "channels.alpha.explicitOnly": { help: "manifest hint" },
      },
    });
  });

  it("does not probe broad runtime public surfaces for channel config metadata", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-dist-config-runtime-");
    const distRoot = path.join(tempRoot, "dist");
    const markerPath = path.join(tempRoot, "runtime-api-loaded");

    const pluginDir = writePlugin(distRoot, {
      entrypoint: "index.js",
      packageOpenClaw: {
        channel: { id: "alpha", label: "Alpha Root Label", blurb: "Alpha Root Description" },
      },
      manifest: {
        configSchema: { type: "object", properties: {} },
        channels: ["alpha"],
        channelConfigs: {
          alpha: { schema: { type: "object", properties: { manifest: { type: "boolean" } } } },
        },
      },
    });
    fs.writeFileSync(
      path.join(pluginDir, "runtime-api.js"),
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(markerPath)}, "loaded", "utf8");`,
        "export const AlphaChannelConfigSchema = {",
        "  schema: { type: 'object', properties: { runtimeApi: { type: 'string' } } },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "api.js"),
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(markerPath)}, "loaded", "utf8");`,
        "export const AlphaChannelConfigSchema = {",
        "  schema: { type: 'object', properties: { api: { type: 'string' } } },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const entries = listBundledPluginMetadata({ rootDir: distRoot });
    const channelConfigs = entries[0]?.manifest.channelConfigs as
      | Record<string, unknown>
      | undefined;
    expect(channelConfigs?.alpha).toEqual({
      schema: {
        type: "object",
        properties: {
          manifest: { type: "boolean" },
        },
      },
      label: "Alpha Root Label",
      description: "Alpha Root Description",
    });
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});

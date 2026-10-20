import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listBundledPluginMetadata } from "./bundled-plugin-metadata.js";
import {
  createGeneratedPluginTempRoot,
  installGeneratedPluginTempRootCleanup,
  writeJson,
} from "./generated-plugin-test-helpers.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

const schemaWarn = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "plugins" ? { ...logger, warn: schemaWarn } : logger;
    },
  };
});

installGeneratedPluginTempRootCleanup();

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  schemaWarn.mockClear();
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

const channel = { id: "alpha", label: "Alpha Root Label", blurb: "Alpha Root Description" };
const explicitHints = { "channels.alpha.explicitOnly": { help: "manifest hint" } };
const schema = (field: string, type = "string") => ({
  type: "object",
  properties: { [field]: { type } },
});

function channelConfig(rootDir: string) {
  return (
    listBundledPluginMetadata({ rootDir })[0]?.manifest.channelConfigs as
      | Record<string, unknown>
      | undefined
  )?.alpha;
}

function writeDistChannel(rootDir: string, field: string, uiHints?: object) {
  return writePlugin(rootDir, {
    entrypoint: "index.js",
    packageOpenClaw: { channel },
    manifest: {
      configSchema: { type: "object", properties: {} },
      channels: ["alpha"],
      channelConfigs: { alpha: { schema: schema(field, "boolean"), ...(uiHints && { uiHints }) } },
    },
  });
}

function writeChannelSchema(pluginDir: string, file: string, field: string, hint: string) {
  fs.mkdirSync(path.dirname(path.join(pluginDir, file)), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, file),
    `export const AlphaChannelConfigSchema = {
  schema: {
    type: 'object',
    properties: { ${field}: { type: 'string' } },
  },
  uiHints: {
    'channels.alpha.generatedOnly': { help: '${hint}' },
  },
};
`,
    "utf8",
  );
}

describe("bundled plugin public surfaces", () => {
  it("merges runtime channel schema metadata with manifest-owned channel config fields", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-channel-configs-");

    const pluginDir = writePlugin(tempRoot, {
      packageOpenClaw: {
        channel: { ...channel, preferOver: ["alpha-legacy"] },
      },
      manifest: {
        channels: ["alpha"],
        channelConfigs: {
          alpha: {
            schema: schema("stale", "boolean"),
            label: "Manifest Label",
            uiHints: explicitHints,
          },
        },
      },
    });
    writeChannelSchema(pluginDir, "src/config-schema.js", "generated", "generated hint");
    expect(channelConfig(tempRoot)).toEqual({
      schema: schema("generated"),
      label: "Manifest Label",
      description: "Alpha Root Description",
      preferOver: ["alpha-legacy"],
      uiHints: {
        "channels.alpha.generatedOnly": { help: "generated hint" },
        ...explicitHints,
      },
    });
    expect(schemaWarn).not.toHaveBeenCalled();
  });

  it("warns when selected channel schema evaluation fails and retains manifest metadata", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-config-failure-");
    const pluginDir = writePlugin(tempRoot, {
      packageOpenClaw: { channel },
      manifest: {
        channels: ["alpha"],
        channelConfigs: {
          alpha: { schema: schema("manifest", "boolean"), uiHints: explicitHints },
        },
      },
    });
    const modulePath = path.join(pluginDir, "src", "config-schema.js");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(
      modulePath,
      'throw new Error("schema fixture initialization failed");\n',
      "utf8",
    );

    expect(channelConfig(tempRoot)).toEqual({
      schema: schema("manifest", "boolean"),
      label: "Alpha Root Label",
      description: "Alpha Root Description",
      uiHints: explicitHints,
    });
    expect(schemaWarn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`from ${modulePath}; using manifest metadata`),
      { error: expect.objectContaining({ message: "schema fixture initialization failed" }) },
    );
  });

  it("captures top-level public surface artifacts without duplicating the primary entrypoints", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-public-artifacts-");

    const pluginDir = writePlugin(tempRoot, {
      packageOpenClaw: { setupEntry: "./setup-entry.ts" },
    });
    for (const filename of ["setup-entry.ts", "api.ts", "runtime-api.ts"]) {
      fs.writeFileSync(path.join(pluginDir, filename), "export {};\n", "utf8");
    }
    expect(listBundledPluginMetadata({ rootDir: tempRoot })[0]).toMatchObject({
      publicSurfaceArtifacts: ["api.js", "runtime-api.js"],
      runtimeSidecarArtifacts: ["runtime-api.js"],
    });
  });

  it("loads channel config metadata from built public surfaces in dist-only roots", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-dist-config-");
    const distRoot = path.join(tempRoot, "dist");

    const pluginDir = writeDistChannel(distRoot, "stale", explicitHints);
    writeChannelSchema(pluginDir, "channel-config-api.js", "built", "built hint");
    expect(channelConfig(distRoot)).toEqual({
      schema: schema("built"),
      label: "Alpha Root Label",
      description: "Alpha Root Description",
      uiHints: {
        "channels.alpha.generatedOnly": { help: "built hint" },
        ...explicitHints,
      },
    });
  });

  it("does not probe broad runtime public surfaces for channel config metadata", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-dist-config-runtime-");
    const distRoot = path.join(tempRoot, "dist");
    const markerPath = path.join(tempRoot, "runtime-api-loaded");

    const pluginDir = writeDistChannel(distRoot, "manifest");
    for (const [file, field] of [
      ["runtime-api.js", "runtimeApi"],
      ["api.js", "api"],
    ] as const) {
      fs.writeFileSync(
        path.join(pluginDir, file),
        [
          "import fs from 'node:fs';",
          `fs.writeFileSync(${JSON.stringify(markerPath)}, "loaded", "utf8");`,
          "export const AlphaChannelConfigSchema = {",
          `  schema: { type: 'object', properties: { ${field}: { type: 'string' } } },`,
          "};",
          "",
        ].join("\n"),
        "utf8",
      );
    }
    expect(channelConfig(distRoot)).toEqual({
      schema: schema("manifest", "boolean"),
      label: "Alpha Root Label",
      description: "Alpha Root Description",
    });
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(schemaWarn).not.toHaveBeenCalled();
  });
});

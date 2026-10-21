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

function fixture(
  params: {
    manifest?: Record<string, unknown>;
    packageOpenClaw?: Record<string, unknown>;
    built?: boolean;
  } = {},
) {
  const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-");
  const root = params.built ? path.join(tempRoot, "dist") : tempRoot;
  const pluginDir = path.join(root, "extensions", "alpha");
  writeJson(path.join(pluginDir, "package.json"), {
    name: "@openclaw/alpha",
    openclaw: { extensions: ["./index.ts"], ...params.packageOpenClaw },
  });
  writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id: "alpha",
    configSchema: { type: "object" },
    ...params.manifest,
  });
  writeModule(pluginDir, params.built ? "index.js" : "index.ts", "export {};\n");
  return { root, pluginDir, tempRoot };
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

function channelFixture(config: object, built = false, preferOver?: string[]) {
  return fixture({
    built,
    packageOpenClaw: { channel: { ...channel, ...(preferOver && { preferOver }) } },
    manifest: {
      ...(built && { configSchema: { type: "object", properties: {} } }),
      channels: ["alpha"],
      channelConfigs: { alpha: config },
    },
  });
}

const expectedConfig = (field: string, extra: object = {}, type = "string") => ({
  schema: schema(field, type),
  label: channel.label,
  description: channel.blurb,
  ...extra,
});

function writeModule(pluginDir: string, file: string, source: string) {
  const target = path.join(pluginDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source, "utf8");
  return target;
}

function writeChannelSchema(pluginDir: string, file: string, field: string, hint: string) {
  const value = {
    schema: schema(field),
    uiHints: { "channels.alpha.generatedOnly": { help: hint } },
  };
  writeModule(pluginDir, file, `export const AlphaChannelConfigSchema = ${JSON.stringify(value)};`);
}

describe("bundled plugin public surfaces", () => {
  it("merges runtime channel schema metadata with manifest-owned channel config fields", () => {
    const { root, pluginDir } = channelFixture(
      {
        schema: schema("stale", "boolean"),
        label: "Manifest Label",
        uiHints: explicitHints,
      },
      false,
      ["alpha-legacy"],
    );
    writeChannelSchema(pluginDir, "src/config-schema.js", "generated", "generated hint");
    expect(channelConfig(root)).toEqual(
      expectedConfig("generated", {
        label: "Manifest Label",
        preferOver: ["alpha-legacy"],
        uiHints: {
          "channels.alpha.generatedOnly": { help: "generated hint" },
          ...explicitHints,
        },
      }),
    );
    expect(schemaWarn).not.toHaveBeenCalled();
  });

  it("warns when selected channel schema evaluation fails and retains manifest metadata", () => {
    const { root, pluginDir } = channelFixture({
      schema: schema("manifest", "boolean"),
      uiHints: explicitHints,
    });
    const modulePath = writeModule(
      pluginDir,
      "src/config-schema.js",
      'throw new Error("schema fixture initialization failed");\n',
    );

    expect(channelConfig(root)).toEqual(
      expectedConfig("manifest", { uiHints: explicitHints }, "boolean"),
    );
    expect(schemaWarn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`from ${modulePath}; using manifest metadata`),
      { error: expect.objectContaining({ message: "schema fixture initialization failed" }) },
    );
  });

  it("captures top-level public surface artifacts without duplicating the primary entrypoints", () => {
    const { root, pluginDir } = fixture({
      packageOpenClaw: { setupEntry: "./setup-entry.ts" },
    });
    for (const filename of ["setup-entry.ts", "api.ts", "runtime-api.ts"]) {
      writeModule(pluginDir, filename, "export {};\n");
    }
    expect(listBundledPluginMetadata({ rootDir: root })[0]).toMatchObject({
      publicSurfaceArtifacts: ["api.js", "runtime-api.js"],
      runtimeSidecarArtifacts: ["runtime-api.js"],
    });
  });

  it("loads channel config metadata from built public surfaces in dist-only roots", () => {
    const { root, pluginDir } = channelFixture(
      {
        schema: schema("stale", "boolean"),
        uiHints: explicitHints,
      },
      true,
    );
    writeChannelSchema(pluginDir, "channel-config-api.js", "built", "built hint");
    expect(channelConfig(root)).toEqual(
      expectedConfig("built", {
        uiHints: {
          "channels.alpha.generatedOnly": { help: "built hint" },
          ...explicitHints,
        },
      }),
    );
  });

  it("does not probe broad runtime public surfaces for channel config metadata", () => {
    const { root, pluginDir, tempRoot } = channelFixture(
      { schema: schema("manifest", "boolean") },
      true,
    );
    const markerPath = path.join(tempRoot, "runtime-api-loaded");

    for (const [file, field] of [
      ["runtime-api.js", "runtimeApi"],
      ["api.js", "api"],
    ] as const) {
      writeModule(
        pluginDir,
        file,
        `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(markerPath)}, "loaded", "utf8");
export const AlphaChannelConfigSchema = ${JSON.stringify({ schema: schema(field) })};
`,
      );
    }
    expect(channelConfig(root)).toEqual(expectedConfig("manifest", {}, "boolean"));
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(schemaWarn).not.toHaveBeenCalled();
  });
});

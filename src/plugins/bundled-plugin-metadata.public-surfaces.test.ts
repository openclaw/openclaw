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

function fixture(config?: object, built = false, preferOver?: readonly string[]) {
  const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-");
  const root = built ? path.join(tempRoot, "dist") : tempRoot;
  const pluginDir = path.join(root, "extensions", "alpha");
  writeJson(path.join(pluginDir, "package.json"), {
    name: "@openclaw/alpha",
    openclaw: {
      extensions: ["./index.ts"],
      ...(config
        ? { channel: { ...channel, ...(preferOver && { preferOver }) } }
        : { setupEntry: "./setup-entry.ts" }),
    },
  });
  writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id: "alpha",
    configSchema: built ? { type: "object", properties: {} } : { type: "object" },
    ...(config && { channels: ["alpha"], channelConfigs: { alpha: config } }),
  });
  writeModule(pluginDir, built ? "index.js" : "index.ts", "export {};\n");
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
  it.each([
    [
      "source",
      false,
      "src/config-schema.js",
      "generated",
      { label: "Manifest Label", preferOver: ["alpha-legacy"] },
    ],
    ["built", true, "channel-config-api.js", "built", {}],
  ] as const)(
    "merges %s channel schema metadata with manifest-owned fields",
    (_name, built, file, field, overrides) => {
      const { preferOver, ...manifestFields } =
        "preferOver" in overrides ? overrides : { preferOver: undefined };
      const { root, pluginDir } = fixture(
        {
          schema: schema("stale", "boolean"),
          uiHints: explicitHints,
          ...manifestFields,
        },
        built,
        preferOver,
      );
      writeChannelSchema(pluginDir, file, field, `${field} hint`);
      expect(channelConfig(root)).toEqual(
        expectedConfig(field, {
          ...overrides,
          uiHints: {
            "channels.alpha.generatedOnly": { help: `${field} hint` },
            ...explicitHints,
          },
        }),
      );
      expect(schemaWarn).not.toHaveBeenCalled();
    },
  );

  it("warns when selected channel schema evaluation fails and retains manifest metadata", () => {
    const { root, pluginDir } = fixture({
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
    const { root, pluginDir } = fixture();
    for (const filename of ["setup-entry.ts", "api.ts", "runtime-api.ts"]) {
      writeModule(pluginDir, filename, "export {};\n");
    }
    expect(listBundledPluginMetadata({ rootDir: root })[0]).toMatchObject({
      publicSurfaceArtifacts: ["api.js", "runtime-api.js"],
      runtimeSidecarArtifacts: ["runtime-api.js"],
    });
  });

  it("does not probe broad runtime public surfaces for channel config metadata", () => {
    const { root, pluginDir, tempRoot } = fixture({ schema: schema("manifest", "boolean") }, true);
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

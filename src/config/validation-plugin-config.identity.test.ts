import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

const manifestRegistry: PluginManifestRegistry = {
  plugins: [
    {
      id: "MiXeD-demo",
      legacyPluginIds: ["previous-demo"],
      origin: "config",
      rootDir: "/tmp/mixed-demo",
      source: "/tmp/mixed-demo/index.js",
      manifestPath: "/tmp/mixed-demo/openclaw.plugin.json",
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      configSchema: {
        type: "object",
        properties: {
          label: { type: "string" },
          greeting: { type: "string", default: "hello" },
        },
        additionalProperties: false,
      },
    },
  ],
  diagnostics: [],
};

describe("mixed-case manifest settings", () => {
  it.each(["mixed-demo", "MiXeD-demo", "previous-demo"])(
    "rejects invalid settings under %s",
    (entryId) => {
      const result = validateConfigObjectRawWithPlugins(
        {
          plugins: {
            allow: [entryId],
            slots: { memory: "none" },
            entries: { [entryId]: { enabled: true, config: { label: 42 } } },
          },
        },
        { pluginMetadataSnapshot: { manifestRegistry } },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual(
          expect.objectContaining({
            path: `plugins.entries.${entryId}.config.label`,
            message: "invalid config: must be string",
          }),
        );
      }
      expect(result.warnings).toEqual([]);
    },
  );

  it.each(["mixed-demo", "MiXeD-demo", "previous-demo"])(
    "applies defaults without duplicating %s",
    (entryId) => {
      const result = validateConfigObjectRawWithPlugins(
        {
          plugins: {
            allow: [entryId],
            slots: { memory: "none" },
            entries: { [entryId]: { enabled: true, config: { label: "kept" } } },
          },
        },
        { pluginMetadataSnapshot: { manifestRegistry } },
      );
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
      if (result.ok) {
        expect(result.config.plugins?.entries).toEqual({
          [entryId]: { enabled: true, config: { label: "kept", greeting: "hello" } },
        });
      }
    },
  );

  it.each([42, "kept"])(
    "keeps settings ownership when another spelling only sets policy: %s",
    (label) => {
      const result = validateConfigObjectRawWithPlugins(
        {
          plugins: {
            allow: ["mixed-demo"],
            slots: { memory: "none" },
            entries: {
              "mixed-demo": { config: { label } },
              "MiXeD-demo": { enabled: true },
            },
          },
        },
        { pluginMetadataSnapshot: { manifestRegistry } },
      );
      expect(result.ok).toBe(typeof label === "string");
      if (result.ok) {
        expect(result.config.plugins?.entries).toEqual({
          "mixed-demo": { config: { label, greeting: "hello" } },
          "MiXeD-demo": { enabled: true },
        });
      } else {
        expect(result.issues).toContainEqual(
          expect.objectContaining({
            path: "plugins.entries.mixed-demo.config.label",
            message: "invalid config: must be string",
          }),
        );
      }
    },
  );
});

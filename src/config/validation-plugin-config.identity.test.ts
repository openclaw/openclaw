import { assert, describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";

const manifestRegistry: PluginManifestRegistry = {
  plugins: [
    createPluginManifestRecordFixture({
      id: "MiXeD-demo",
      legacyPluginIds: ["previous-demo"],
      origin: "config",
      rootDir: "/tmp/mixed-demo",
      configSchema: {
        type: "object",
        properties: {
          label: { type: "string" },
          greeting: { type: "string", default: "hello" },
        },
        additionalProperties: false,
      },
    }),
  ],
  diagnostics: [],
};

function validate(
  entries: NonNullable<NonNullable<OpenClawConfig["plugins"]>["entries"]>,
  entryId = "mixed-demo",
) {
  const result = validateConfigObjectRawWithPlugins(
    { plugins: { allow: [entryId], slots: { memory: "none" }, entries } },
    { pluginMetadataSnapshot: { manifestRegistry } },
  );
  expect(result.warnings).toEqual([]);
  return result;
}

function invalidLabel(entryId: string) {
  return expect.objectContaining({
    path: `plugins.entries.${entryId}.config.label`,
    message: "invalid config: must be string",
  });
}

describe("mixed-case manifest settings", () => {
  it.each(["mixed-demo", "MiXeD-demo", "previous-demo"])(
    "rejects invalid settings under %s",
    (entryId) => {
      const result = validate({ [entryId]: { enabled: true, config: { label: 42 } } }, entryId);
      assert(!result.ok);
      expect(result.issues).toContainEqual(invalidLabel(entryId));
    },
  );

  it.each(["mixed-demo", "MiXeD-demo", "previous-demo"])(
    "applies defaults without duplicating %s",
    (entryId) => {
      const result = validate({ [entryId]: { enabled: true, config: { label: "kept" } } }, entryId);
      assert(result.ok);
      expect(result.config.plugins?.entries).toEqual({
        [entryId]: { enabled: true, config: { label: "kept", greeting: "hello" } },
      });
    },
  );

  it.each([42, "kept"])(
    "keeps settings ownership when another spelling only sets policy: %s",
    (label) => {
      const result = validate({
        "mixed-demo": { config: { label } },
        "MiXeD-demo": { enabled: true },
      });
      expect(result.ok).toBe(typeof label === "string");
      if (result.ok) {
        expect(result.config.plugins?.entries).toEqual({
          "mixed-demo": { config: { label, greeting: "hello" } },
          "MiXeD-demo": { enabled: true },
        });
      } else {
        expect(result.issues).toContainEqual(invalidLabel("mixed-demo"));
      }
    },
  );
});

it.each([
  { name: "absent settings", entry: undefined },
  { name: "policy-only settings", entry: { enabled: true } },
  { name: "authored empty settings", entry: { config: {} } },
])("preserves $name when a plugin has no schema defaults", ({ entry }) => {
  const expected = structuredClone(entry);
  const result = validateConfigObjectWithPlugins(
    {
      plugins: {
        slots: { memory: "none" },
        ...(entry ? { entries: { "empty-defaults": entry } } : {}),
      },
    },
    {
      pluginMetadataSnapshot: {
        manifestRegistry: {
          plugins: [
            createPluginManifestRecordFixture({
              id: "empty-defaults",
              origin: "bundled",
              enabledByDefault: true,
              configSchema: { type: "object", properties: {}, additionalProperties: false },
            }),
          ],
          diagnostics: [],
        },
      },
    },
  );
  assert(result.ok);
  expect(result.config.plugins?.entries?.["empty-defaults"]).toEqual(expected);
});

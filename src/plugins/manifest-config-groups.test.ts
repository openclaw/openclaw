import fs from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigSchemaLookupResultSchema,
  ConfigSchemaResponseSchema,
} from "../../packages/gateway-protocol/src/schema/config.js";
import { collectPluginSchemaMetadataCore } from "../config/channel-config-metadata.js";
import { buildConfigSchemaCore, lookupConfigSchema } from "../config/schema.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const roots: string[] = [];
const configPath = "plugins.entries.grouped-plugin.config";
const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    storage: { type: "object", properties: { path: { type: "string" } } },
    timeout: { type: "integer" },
  },
};
const groups = [
  { id: "storage", title: "Storage", order: 20, properties: ["storage"] },
  { id: "general", title: "General", order: 10, properties: ["enabled"] },
];

function loadMetadata(configGroups: unknown) {
  const rootDir = makeTrackedTempDir("openclaw-config-groups", roots);
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({ id: "grouped-plugin", configSchema, configGroups }),
  );
  const registry = loadPluginManifestRegistryCore({
    installRecords: {},
    candidates: [
      {
        idHint: "grouped-plugin",
        rootDir,
        source: path.join(rootDir, "index.ts"),
        origin: "workspace",
      },
    ],
  });
  expect(registry.plugins).toHaveLength(1);
  return collectPluginSchemaMetadataCore(registry);
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(roots);
});

describe("authored plugin config groups", () => {
  it("carries groups through discovery into schema and lookup without hiding ungrouped fields", () => {
    const response = buildConfigSchemaCore({ plugins: loadMetadata(groups) });
    const lookup = lookupConfigSchema(response, configPath);

    expect(response.uiHints[configPath]).toMatchObject({ groups });
    expect(lookup).toMatchObject({
      hint: { groups },
      children: expect.arrayContaining([
        expect.objectContaining({ key: "enabled" }),
        expect.objectContaining({ key: "storage", hasChildren: true }),
        expect.objectContaining({ key: "timeout" }),
      ]),
    });
    expect(lookupConfigSchema(response, `${configPath}.storage.path`)?.schema.type).toBe("string");
    expect(Value.Check(ConfigSchemaResponseSchema, response)).toBe(true);
    expect(Value.Check(ConfigSchemaLookupResultSchema, lookup)).toBe(true);
  });

  it("refreshes cached schema presentation when only authored grouping changes", () => {
    const first = buildConfigSchemaCore({ plugins: loadMetadata(groups) });
    const renamed = [{ ...groups[0], title: "Data storage" }, groups[1]];
    const next = buildConfigSchemaCore({ plugins: loadMetadata(renamed) });

    expect(first.uiHints[configPath]).toMatchObject({ groups });
    expect(next.uiHints[configPath]).toMatchObject({ groups: renamed });
    expect(next.schema).toEqual(first.schema);
  });

  it.each([
    { label: "missing", value: undefined },
    { label: "empty", value: [] },
    { label: "non-array", value: {} },
    { label: "missing title", value: [{ id: "general", properties: ["enabled"] }] },
    { label: "empty title", value: [{ ...groups[0], title: " " }] },
    { label: "empty id", value: [{ ...groups[0], id: "" }] },
    { label: "non-integer order", value: [{ ...groups[0], order: 1.5 }] },
    { label: "empty properties", value: [{ ...groups[0], properties: [] }] },
    { label: "duplicate id", value: [groups[0], { ...groups[1], id: "storage" }] },
    { label: "duplicate property", value: [groups[0], { ...groups[1], properties: ["storage"] }] },
    { label: "repeated property", value: [{ ...groups[0], properties: ["storage", "storage"] }] },
    { label: "unknown property", value: [{ ...groups[0], properties: ["unknown"] }] },
    { label: "nested path", value: [{ ...groups[0], properties: ["storage.path"] }] },
  ])("keeps the plugin and every config field available with $label grouping", ({ value }) => {
    const response = buildConfigSchemaCore({ plugins: loadMetadata(value) });
    const lookup = lookupConfigSchema(response, configPath);

    expect(response.uiHints[configPath]).not.toHaveProperty("groups");
    expect(lookup?.children.map((child) => child.key).toSorted()).toEqual([
      "enabled",
      "storage",
      "timeout",
    ]);
    expect(lookupConfigSchema(response, `${configPath}.storage.path`)?.schema.type).toBe("string");
  });
});

import fs from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, expect, it } from "vitest";
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
const id = "grouped-plugin";
const configPath = `plugins.entries.${id}.config`;
const properties = {
  enabled: { type: "boolean" },
  storage: { type: "object", properties: { path: { type: "string" } } },
  timeout: { type: "integer" },
};
const configSchema = { type: "object", additionalProperties: false, properties };
const groups = [
  { id: "storage", title: "Storage", order: 20, properties: ["storage"] },
  { id: "general", title: "General", order: 10, properties: ["enabled"] },
];

function schemaFor(configGroups: unknown, uiHints?: unknown) {
  const rootDir = makeTrackedTempDir("openclaw-config-groups", roots);
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({ id, configSchema, configGroups, uiHints }),
  );
  const source = path.join(rootDir, "index.ts");
  const registry = loadPluginManifestRegistryCore({
    installRecords: {},
    candidates: [{ idHint: id, rootDir, source, origin: "workspace" }],
  });
  const response = buildConfigSchemaCore({ plugins: collectPluginSchemaMetadataCore(registry) });
  const lookup = lookupConfigSchema(response, configPath);
  expect(Value.Check(ConfigSchemaResponseSchema, response)).toBe(true);
  expect(Value.Check(ConfigSchemaLookupResultSchema, lookup)).toBe(true);
  expect(lookupConfigSchema(response, `${configPath}.storage.path`)?.schema.type).toBe("string");
  return { response, lookup };
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(roots);
});

it.each([true, false, "yes"])("normalizes and publishes multiline hint %j", (multiline) => {
  const { response } = schemaFor(groups, { "storage.path": { multiline } });
  const lookup = lookupConfigSchema(response, `${configPath}.storage.path`);
  expect(lookup?.hint?.multiline).toBe(typeof multiline === "boolean" ? multiline : undefined);
  expect(Value.Check(ConfigSchemaLookupResultSchema, lookup)).toBe(true);
});

it("publishes all fields and refreshes presentation when only authored grouping changes", () => {
  const { response: first, lookup } = schemaFor(groups);
  const renamed = [{ ...groups[0], title: "Data storage" }, groups[1]];
  const { response: next } = schemaFor(renamed);

  expect(first.uiHints[configPath]).toMatchObject({ groups });
  const storage = expect.objectContaining({ key: "storage", hasChildren: true });
  expect(lookup).toMatchObject({ hint: { groups }, children: expect.arrayContaining([storage]) });
  expect(lookup?.children.map((child) => child.key).toSorted()).toEqual(Object.keys(properties));
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
])("keeps every config field available with $label grouping", ({ value }) => {
  const { response, lookup } = schemaFor(value);
  expect(response.uiHints[configPath]).not.toHaveProperty("groups");
  expect(lookup?.children.map((child) => child.key).toSorted()).toEqual(Object.keys(properties));
});

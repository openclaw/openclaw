import { describe, expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { buildBaseHints } from "./schema.hints.js";
import type { ConfigJsonSchemaObject as JsonSchemaNode } from "./schema.shared.js";

function collectSchemaLeafPaths(
  schema: JsonSchemaNode,
  path = "",
  leaves = new Set<string>(),
  visited = new WeakMap<object, Set<string>>(),
): Set<string> {
  const priorPaths = visited.get(schema) ?? new Set<string>();
  if (priorPaths.has(path)) {
    return leaves;
  }
  priorPaths.add(path);
  visited.set(schema, priorPaths);

  const children: [string, JsonSchemaNode][] = Object.entries(schema.properties ?? {}).map(
    ([key, child]) => [path ? `${path}.${key}` : key, child],
  );
  const wildcard = path ? `${path}.*` : "*";
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    children.push([wildcard, schema.additionalProperties]);
  }
  const items = Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : [];
  children.push(...items.map((item): [string, JsonSchemaNode] => [wildcard, item]));
  for (const branches of [schema.anyOf, schema.oneOf, schema.allOf]) {
    children.push(...(branches ?? []).map((branch): [string, JsonSchemaNode] => [path, branch]));
  }
  for (const [childPath, child] of children) {
    collectSchemaLeafPaths(child, childPath, leaves, visited);
  }
  if (path && children.length === 0) {
    leaves.add(path);
  }
  return leaves;
}

function formatMissingTierFailure(paths: readonly string[]): string {
  const stubs = paths.map((path) => `  ${JSON.stringify(path)}: { advanced: true },`).join("\n");
  return `${paths.length} config path(s) have no tier declaration in src/config/schema.tiers.ts:\n${stubs}`;
}

describe("config tier coverage", () => {
  const response = computeBaseConfigSchemaResponse({ generatedAt: "tier-quality-test" });
  const schema = response.schema as JsonSchemaNode;
  const leaves = [...collectSchemaLeafPaths(schema)].toSorted();

  it("requires every root section to declare a tier boundary", () => {
    const authoredHints = buildBaseHints();
    const missing = Object.keys(schema.properties ?? {})
      .filter((path) => typeof authoredHints[path]?.advanced !== "boolean")
      .toSorted();
    expect(missing, formatMissingTierFailure(missing)).toEqual([]);
  });

  it("materializes a deterministic tier on every baseline leaf", () => {
    const missing = leaves.filter((path) => typeof response.uiHints[path]?.advanced !== "boolean");
    expect(missing, formatMissingTierFailure(missing)).toEqual([]);
  });

  it("keeps the curated common leaf set reviewable", () => {
    const common = leaves.filter((path) => response.uiHints[path]?.advanced === false);
    expect(common).toMatchSnapshot();
  });

  it("documents the Appearance-owned interface language preference", () => {
    const locale = schema.properties?.ui?.properties?.prefs?.properties?.locale;
    expect(locale?.title).toBe("Interface language");
    expect(locale?.description).toContain("browser or system language");
    expect(locale?.description).toContain("agents.defaults.userTimezone");
  });
});

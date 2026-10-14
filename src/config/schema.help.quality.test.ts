// Checks config help text quality and coverage.

import { describe, expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { buildBaseHints } from "./schema.hints.js";

type JsonSchemaNode = {
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: JsonSchemaNode | boolean;
  items?: JsonSchemaNode | JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
};

function collectSchemaLeafPaths(
  schema: JsonSchemaNode,
  path = "",
  leaves = new Set<string>(),
  visited = new WeakMap<object, Set<string>>(),
): Set<string> {
  const priorPaths = visited.get(schema);
  if (priorPaths?.has(path)) {
    return leaves;
  }
  if (priorPaths) {
    priorPaths.add(path);
  } else {
    visited.set(schema, new Set([path]));
  }

  let hasChildren = false;
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    hasChildren = true;
    collectSchemaLeafPaths(child, path ? `${path}.${key}` : key, leaves, visited);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    hasChildren = true;
    collectSchemaLeafPaths(schema.additionalProperties, path ? `${path}.*` : "*", leaves, visited);
  }
  const items = Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : [];
  for (const item of items) {
    hasChildren = true;
    collectSchemaLeafPaths(item, path ? `${path}.*` : "*", leaves, visited);
  }
  for (const branches of [schema.anyOf, schema.oneOf, schema.allOf]) {
    for (const branch of branches ?? []) {
      hasChildren = true;
      collectSchemaLeafPaths(branch, path, leaves, visited);
    }
  }
  if (path && !hasChildren) {
    leaves.add(path);
  }
  return leaves;
}

function formatMissingTierFailure(paths: readonly string[]): string {
  const stubs = paths.map((path) => `  ${JSON.stringify(path)}: { advanced: true },`).join("\n");
  return [
    `${paths.length} config path(s) have no tier declaration.`,
    "Add common/advanced boundaries in src/config/schema.tiers.ts:",
    "",
    stubs,
    "",
    "New leaves inherit their nearest declared ancestor; use a leaf hint for exceptions.",
  ].join("\n");
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
});

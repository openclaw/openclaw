// Verifies generated base config schema snapshots and sensitive redaction.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";

type TestJsonSchema = {
  additionalProperties?: TestJsonSchema | boolean;
  allOf?: TestJsonSchema[];
  anyOf?: TestJsonSchema[];
  const?: unknown;
  enum?: unknown[];
  items?: TestJsonSchema | TestJsonSchema[];
  oneOf?: TestJsonSchema[];
  properties?: Record<string, TestJsonSchema>;
  type?: unknown;
};

const BASE_CONFIG_SCHEMA = computeBaseConfigSchemaResponse({
  generatedAt: "2026-05-05T00:00:00.000Z",
});
const BASE_SCHEMA = BASE_CONFIG_SCHEMA.schema as TestJsonSchema;

const METADATA_KEYS = new Set(["default", "description", "nullable", "tags", "title", "x-tags"]);

function hasOnlyMetadataKeys(schema: TestJsonSchema): boolean {
  return Object.keys(schema).every((key) => METADATA_KEYS.has(key));
}

function collectMetadataOnlyCompositionBranches(
  schema: TestJsonSchema,
  path: string[] = [],
  hits: string[] = [],
): string[] {
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    for (const [index, branch] of (schema[keyword] ?? []).entries()) {
      const branchPath = `${path.join(".") || "<root>"}.${keyword}[${index}]`;
      if (hasOnlyMetadataKeys(branch)) {
        hits.push(branchPath);
      }
      collectMetadataOnlyCompositionBranches(branch, [branchPath], hits);
    }
  }

  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    collectMetadataOnlyCompositionBranches(child, [...path, key], hits);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    collectMetadataOnlyCompositionBranches(schema.additionalProperties, [...path, "*"], hits);
  }
  const items = Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : [];
  for (const [index, child] of items.entries()) {
    collectMetadataOnlyCompositionBranches(child, [...path, `items[${index}]`], hits);
  }

  return hits;
}

describe("base config schema", () => {
  it("returns independent schema and hint trees for a fixed generatedAt timestamp", () => {
    const response = computeBaseConfigSchemaResponse({
      generatedAt: BASE_CONFIG_SCHEMA.generatedAt,
    });
    expect(response).toEqual(BASE_CONFIG_SCHEMA);
    delete (response.schema.properties as Record<string, unknown>).logging;
    const hint = expectDefined(response.uiHints["mcp.servers.*.url"], "URL hint");
    hint.help = "Changed by caller";
    hint.tags?.push("caller-tag");
    expect(
      computeBaseConfigSchemaResponse({ generatedAt: BASE_CONFIG_SCHEMA.generatedAt }),
    ).toEqual(BASE_CONFIG_SCHEMA);
  });

  it("does not publish metadata-only composition branches", () => {
    expect(collectMetadataOnlyCompositionBranches(BASE_SCHEMA)).toEqual([]);
  });
});

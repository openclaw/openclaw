// Verifies generated config documentation baselines stay stable.
import { describe, expect, it, vi } from "vitest";
import { renderConfigDocBaselineArtifacts } from "./doc-baseline.js";

vi.mock("./doc-baseline.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doc-baseline.runtime.js")>();
  return {
    ...actual,
    loadPluginManifestRegistry: () => ({ plugins: [] }),
    collectChannelSchemaMetadata: () => [],
    collectPluginSchemaMetadata: () => [],
    buildConfigSchema: () => ({
      schema: {
        type: "object",
        required: ["mapValues", "mixedValues", "singleValues"],
        additionalProperties: { type: "string" },
        properties: {
          mapValues: {
            type: "object",
            additionalProperties: { type: "boolean" },
          },
          mixedValues: {
            type: "array",
            additionalProperties: { type: "string", enum: ["extra"] },
            items: [null, true, [], { type: "number", enum: [42] }],
          },
          singleValues: {
            type: "array",
            items: { type: "string" },
          },
          tupleValues: {
            type: "array",
            items: [
              { type: "string", enum: ["alpha"] },
              { type: "number", enum: [42] },
            ],
          },
        },
      },
      uiHints: {},
      version: "test",
      generatedAt: "test",
    }),
  };
});

describe("config doc baseline", () => {
  it("renders optional wildcards and merges tuple metadata through the public renderer", async () => {
    const { baseline } = await renderConfigDocBaselineArtifacts();

    expect(baseline.coreEntries).toEqual([
      {
        path: "*",
        kind: "core",
        type: "string",
        required: false,
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: false,
      },
      {
        path: "mapValues",
        kind: "core",
        type: "object",
        required: true,
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: true,
      },
      {
        path: "mapValues.*",
        kind: "core",
        type: "boolean",
        required: false,
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: false,
      },
      {
        path: "mixedValues",
        kind: "core",
        type: "array",
        required: true,
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: true,
      },
      {
        path: "mixedValues.*",
        kind: "core",
        type: ["number", "string"],
        required: false,
        enumValues: ["extra", 42],
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: false,
      },
      {
        path: "singleValues",
        kind: "core",
        type: "array",
        required: true,
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: true,
      },
      {
        path: "singleValues.*",
        kind: "core",
        type: "string",
        required: false,
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: false,
      },
      {
        path: "tupleValues",
        kind: "core",
        type: "array",
        required: false,
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: true,
      },
      {
        path: "tupleValues.*",
        kind: "core",
        type: ["number", "string"],
        required: false,
        enumValues: ["alpha", 42],
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: false,
      },
    ]);
  });
});

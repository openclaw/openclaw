import { expect, it, vi } from "vitest";
import { renderConfigDocBaselineArtifacts } from "./doc-baseline.js";

vi.mock("./doc-baseline.runtime.js", async () => {
  const { collectBundledChannelConfigsCore } =
    await import("../plugins/bundled-channel-config-metadata.js");
  return {
    collectBundledChannelConfigs: collectBundledChannelConfigsCore,
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

it("renders optional wildcards and merges tuple metadata through the public renderer", async () => {
  const { baseline } = await renderConfigDocBaselineArtifacts();

  const entry = (path: string, type: string | string[], required = false, hasChildren = false) => ({
    path,
    type,
    required,
    hasChildren,
    kind: "core",
    deprecated: false,
    sensitive: false,
    tags: [],
  });
  expect(baseline.coreEntries).toEqual([
    entry("*", "string"),
    entry("mapValues", "object", true, true),
    entry("mapValues.*", "boolean"),
    entry("mixedValues", "array", true, true),
    {
      ...entry("mixedValues.*", ["number", "string"]),
      enumValues: ["extra", 42],
    },
    entry("singleValues", "array", true, true),
    entry("singleValues.*", "string"),
    entry("tupleValues", "array", false, true),
    {
      ...entry("tupleValues.*", ["number", "string"]),
      enumValues: ["alpha", 42],
    },
  ]);
});

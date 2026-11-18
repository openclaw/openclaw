import { expect, it } from "vitest";
import { createPluginToolMetadataLookup } from "./tool-metadata.js";

it.each([
  ["plugin", "a\uE000b", "plugin\uE000a", "b"],
  ["plugin", "a\u0000b", "plugin\u0000a", "b"],
])(
  "keeps metadata distinct for separator-like owner/name pairs %s/%s and %s/%s",
  (firstPluginId, firstToolName, secondPluginId, secondToolName) => {
    const firstMetadata = { toolName: firstToolName, displayName: "first" };
    const secondMetadata = { toolName: secondToolName, displayName: "second" };
    const metadataFor = createPluginToolMetadataLookup([
      { pluginId: firstPluginId, source: "test", metadata: firstMetadata },
      { pluginId: secondPluginId, source: "test", metadata: secondMetadata },
    ]);

    expect(metadataFor(firstPluginId, firstToolName)).toBe(firstMetadata);
    expect(metadataFor(secondPluginId, secondToolName)).toBe(secondMetadata);
  },
);

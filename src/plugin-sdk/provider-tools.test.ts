import { describe, expect, it } from "vitest";
import {
  applyXaiModelCompat,
  buildProviderToolCompatFamilyHooks,
  inspectGeminiToolSchemas,
  normalizeGeminiToolSchemas,
  resolveXaiModelCompatPatch,
} from "./provider-tools.js";

describe("buildProviderToolCompatFamilyHooks", () => {
  it("covers the tool compat family matrix", () => {
    const cases = [
      {
        family: "gemini" as const,
        normalizeToolSchemas: normalizeGeminiToolSchemas,
        inspectToolSchemas: inspectGeminiToolSchemas,
      },
    ];

    for (const testCase of cases) {
      const hooks = buildProviderToolCompatFamilyHooks(testCase.family);

      expect(hooks.normalizeToolSchemas).toBe(testCase.normalizeToolSchemas);
      expect(hooks.inspectToolSchemas).toBe(testCase.inspectToolSchemas);
    }
  });

  it("covers the shared xAI tool compat patch", () => {
    const patch = resolveXaiModelCompatPatch();

    expect(patch).toMatchObject({
      toolSchemaProfile: "xai",
      nativeWebSearchTool: true,
      toolCallArgumentsEncoding: "html-entities",
    });
    expect(patch.unsupportedToolSchemaKeywords).toEqual(
      expect.arrayContaining(["minLength", "maxLength", "minItems", "maxItems"]),
    );

    expect(
      applyXaiModelCompat({
        id: "grok-4",
        compat: {
          supportsUsageInStreaming: true,
        },
      }),
    ).toMatchObject({
      compat: {
        supportsUsageInStreaming: true,
        toolSchemaProfile: "xai",
        nativeWebSearchTool: true,
        toolCallArgumentsEncoding: "html-entities",
      },
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  buildProviderToolCompatFamilyHooks,
  inspectGeminiToolSchemas,
  normalizeGeminiToolSchemas,
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
});

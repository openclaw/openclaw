import { describe, expect, it } from "vitest";
import {
  buildProviderToolCompatFamilyHooks,
  inspectGeminiToolSchemas,
  normalizeGeminiToolSchemas,
} from "./provider-tools.js";

describe("buildProviderToolCompatFamilyHooks", () => {
  it("maps the gemini family to the shared schema helpers", () => {
    const hooks = buildProviderToolCompatFamilyHooks("gemini");

    expect(hooks.normalizeToolSchemas).toBe(normalizeGeminiToolSchemas);
    expect(hooks.inspectToolSchemas).toBe(inspectGeminiToolSchemas);
  });
});

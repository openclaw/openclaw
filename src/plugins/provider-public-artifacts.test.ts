import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { resolveBundledProviderPolicySurface } from "./provider-public-artifacts.js";

describe("provider public artifacts", () => {
  it("loads a lightweight bundled provider policy artifact smoke", () => {
    const surface = resolveBundledProviderPolicySurface("openai");
    expect(surface?.normalizeConfig).toBeTypeOf("function");

    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      models: [],
    };
    expect(
      surface?.normalizeConfig?.({
        provider: "openai",
        providerConfig,
      }),
    ).toBe(providerConfig);
  });
});

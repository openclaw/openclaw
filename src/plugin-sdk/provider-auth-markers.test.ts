import { describe, expect, it } from "vitest";
import { isNonSecretApiKeyMarker as canonicalIsNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { isNonSecretApiKeyMarker } from "./provider-auth-markers.js";

describe("provider auth marker facade", () => {
  it("uses the canonical marker policy", () => {
    expect(isNonSecretApiKeyMarker).toBe(canonicalIsNonSecretApiKeyMarker);
    expect(isNonSecretApiKeyMarker("secretref-managed")).toBe(true);
    expect(isNonSecretApiKeyMarker("secretref-env:OPENAI_API_KEY")).toBe(true);
    expect(isNonSecretApiKeyMarker("fixture-provider-credential")).toBe(false);
    expect(isNonSecretApiKeyMarker("OPENAI_API_KEY", { includeEnvVarName: false })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { isNonSecretApiKeyMarker as canonicalIsNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { isNonSecretApiKeyMarker } from "./provider-auth-markers.js";

describe("provider auth marker facade", () => {
  it("uses the canonical marker policy", () => {
    expect(isNonSecretApiKeyMarker).toBe(canonicalIsNonSecretApiKeyMarker);
  });
});

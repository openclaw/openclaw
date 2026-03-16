import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANTHROPIC_AZURE_MODEL_ID,
  buildAnthropicAzureModelDefinition,
  normalizeAnthropicAzureBaseUrl,
  resolveAnthropicAzureBaseUrlFromEnv,
  resolveAnthropicAzureResourceName,
} from "./anthropic-azure-utils.js";

describe("anthropic-azure-utils", () => {
  it("normalizes resource names into Azure base URLs", () => {
    expect(normalizeAnthropicAzureBaseUrl("Fabric-Hub")).toBe(
      "https://fabric-hub.services.ai.azure.com/anthropic",
    );
  });

  it("rejects resource names with invalid characters instead of silently stripping", () => {
    expect(() => normalizeAnthropicAzureBaseUrl("fabric_hub")).toThrow(
      /contains invalid characters/,
    );
    expect(() => normalizeAnthropicAzureBaseUrl("my resource")).toThrow(
      /contains invalid characters/,
    );
  });

  it("normalizes existing base URLs and enforces suffix", () => {
    expect(
      normalizeAnthropicAzureBaseUrl("https://fabric-hub.services.ai.azure.com/anthropic/"),
    ).toBe("https://fabric-hub.services.ai.azure.com/anthropic");
  });

  it("derives resource name from normalized URL", () => {
    expect(
      resolveAnthropicAzureResourceName("https://fabric-hub.services.ai.azure.com/anthropic"),
    ).toBe("fabric-hub");
  });

  it("resolves env vars preferring base URLs over resources", () => {
    const env = {
      ANTHROPIC_FOUNDRY_BASE_URL: "https://env-base.services.ai.azure.com/anthropic",
      ANTHROPIC_FOUNDRY_RESOURCE: "ignored-resource",
    } as NodeJS.ProcessEnv;
    expect(resolveAnthropicAzureBaseUrlFromEnv(env)).toBe(
      "https://env-base.services.ai.azure.com/anthropic",
    );
  });

  it("falls back to resource env vars when no base URL provided", () => {
    const env = {
      ANTHROPIC_FOUNDRY_RESOURCE: "fallback-resource",
    } as NodeJS.ProcessEnv;
    expect(resolveAnthropicAzureBaseUrlFromEnv(env)).toBe(
      "https://fallback-resource.services.ai.azure.com/anthropic",
    );
  });

  it("builds model definitions with defaults", () => {
    const model = buildAnthropicAzureModelDefinition({ id: DEFAULT_ANTHROPIC_AZURE_MODEL_ID });
    expect(model.id).toBe(DEFAULT_ANTHROPIC_AZURE_MODEL_ID);
    expect(model.input).toContain("text");
  });
});

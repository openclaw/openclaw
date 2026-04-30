import { vi } from "vitest";

export async function createAvailableModelAuthMockModule() {
  const actual =
    await vi.importActual<typeof import("../agents/model-auth.js")>("../agents/model-auth.js");
  return {
    hasAvailableAuthForProvider: vi.fn(() => true),
    isLocalBaseUrl: vi.fn(actual.isLocalBaseUrl),
    resolveApiKeyForProvider: vi.fn(async () => ({
      apiKey: "test-key",
      source: "test",
      mode: "api-key",
    })),
    requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? "test-key"),
  };
}

export function createEmptyCapabilityProviderMockModule() {
  return {
    resolvePluginCapabilityProviders: () => [],
  };
}

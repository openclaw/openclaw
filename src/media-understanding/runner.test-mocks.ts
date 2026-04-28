import { vi } from "vitest";

export function createAvailableModelAuthMockModule() {
  return {
    hasAvailableAuthForProvider: vi.fn(() => true),
    isLocalBaseUrl: vi.fn((baseUrl: string) => {
      try {
        const host = new URL(baseUrl).hostname.toLowerCase();
        return (
          host === "localhost" ||
          host === "127.0.0.1" ||
          host === "0.0.0.0" ||
          host === "[::1]" ||
          host === "[::ffff:7f00:1]" ||
          host === "[::ffff:127.0.0.1]"
        );
      } catch {
        return false;
      }
    }),
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

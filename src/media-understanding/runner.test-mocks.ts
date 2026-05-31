import { vi } from "vitest";

export function createAvailableModelAuthMockModule() {
  class ProviderAuthError extends Error {
    constructor(
      readonly code: "missing-api-key" | "missing-provider-auth",
      readonly provider: string,
      message: string,
    ) {
      super(message);
      this.name = "ProviderAuthError";
    }
  }

  return {
    hasAvailableAuthForProvider: vi.fn(() => true),
    resolveApiKeyForProvider: vi.fn(async () => ({
      apiKey: "test-key",
      source: "test",
      mode: "api-key",
    })),
    requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? "test-key"),
    ProviderAuthError,
    isProviderAuthError: vi.fn(
      (err: unknown, code?: "missing-api-key" | "missing-provider-auth") =>
        err instanceof ProviderAuthError && (!code || err.code === code),
    ),
  };
}

export function createEmptyCapabilityProviderMockModule() {
  return {
    resolvePluginCapabilityProviders: () => [],
  };
}

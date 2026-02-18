import { vi } from "vitest";

export function createModelAuthMockModule(): {
  resolveApiKeyForProvider: ReturnType<typeof vi.fn>;
  requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => string;
} {
  return {
    resolveApiKeyForProvider: vi.fn(),
    requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
      if (auth?.apiKey) {
        return auth.apiKey;
      }
      throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`);
    },
  };
}

import { vi } from "vitest";

type ModelAuthMockModule = {
  resolveApiKeyForProvider: (...args: unknown[]) => unknown;
  requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => string;
};

export function createModelAuthMockModule(): ModelAuthMockModule {
  return {
    resolveApiKeyForProvider: vi.fn() as (...args: unknown[]) => unknown,
    requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
      if (auth?.apiKey) {
        return auth.apiKey;
      }
      throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`);
    },
  };
}

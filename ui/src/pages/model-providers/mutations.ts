export function buildProviderApiKeyPatch(provider: string, apiKey: string | null) {
  return {
    models: {
      providers: {
        [provider]: { apiKey },
      },
    },
  };
}

export function buildDefaultModelsPatch(
  primary: string,
  fallbacks: readonly string[],
  utilityModel: string | null,
) {
  return {
    agents: {
      defaults: {
        model: fallbacks.length > 0 ? { primary, fallbacks: [...fallbacks] } : primary,
        utilityModel,
      },
    },
  };
}

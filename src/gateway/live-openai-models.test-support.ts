import type { ModelsConfig } from "../config/types.models.js";

export function liveOpenAiApiKeyModels(): ModelsConfig {
  return {
    mode: "merge",
    providers: {
      openai: {
        api: "openai-responses",
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        baseUrl: "https://api.openai.com/v1",
        models: [],
      },
    },
  };
}

import type { OpenClawConfig } from "../../../../src/config/types.js";
import type { ModelProviderConfig } from "../../../../src/config/types.models.js";
import type {
  MediaUnderstandingCapabilityConfig,
  MediaUnderstandingModelConfig,
} from "../../../../src/config/types.tools.js";

export function audioConfig(
  provider: string,
  model: string,
  connection: ModelProviderConfig,
  audio: MediaUnderstandingCapabilityConfig,
  fallbacks: MediaUnderstandingModelConfig[] = [],
): OpenClawConfig {
  return {
    models: { providers: { [provider]: connection } },
    tools: {
      media: {
        models: [{ provider, model, capabilities: ["audio"] }, ...fallbacks],
        audio: { enabled: true, ...audio },
      },
    },
  };
}

import { createSingleChannelExtensionVitestConfig } from "./vitest.extension-channel-single-config.ts";

export function createExtensionOpenAICompatibleEmbeddingsVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createSingleChannelExtensionVitestConfig("openai-compatible-embeddings", env);
}

export default createExtensionOpenAICompatibleEmbeddingsVitestConfig();

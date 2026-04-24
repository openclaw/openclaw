import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";

export const GPT5_CONTRACT_MODEL_ID = "gpt-5.4";
export const GPT5_PREFIXED_CONTRACT_MODEL_ID = "openai/gpt-5.4";
export const NON_GPT5_CONTRACT_MODEL_ID = "gpt-4.1";
export const OPENAI_CONTRACT_PROVIDER_ID = "openai";
export const OPENAI_CODEX_CONTRACT_PROVIDER_ID = "openai-codex";
export const CODEX_CONTRACT_PROVIDER_ID = "codex";
export const NON_OPENAI_CONTRACT_PROVIDER_ID = "openrouter";

export function openAiPluginPersonalityConfig(personality: "friendly" | "off"): OpenClawConfig {
  return {
    plugins: {
      entries: {
        openai: {
          config: { personality },
        },
      },
    },
  } as OpenClawConfig;
}

export function sharedGpt5PersonalityConfig(personality: "friendly" | "off"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        promptOverlays: {
          gpt5: { personality },
        },
      },
    },
  } as OpenClawConfig;
}

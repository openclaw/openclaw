import { loadBundledPluginContractApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type AnthropicContractSurface = typeof import("@openclaw/anthropic/contract-api.js");

const {
  createAnthropicBetaHeadersWrapper,
  createAnthropicFastModeWrapper,
  createAnthropicServiceTierWrapper,
  resolveAnthropicBetas,
  resolveAnthropicFastMode,
  resolveAnthropicServiceTier,
} = loadBundledPluginContractApiSync<AnthropicContractSurface>("anthropic");

export {
  createAnthropicBetaHeadersWrapper,
  createAnthropicFastModeWrapper,
  createAnthropicServiceTierWrapper,
  resolveAnthropicBetas,
  resolveAnthropicFastMode,
  resolveAnthropicServiceTier,
};

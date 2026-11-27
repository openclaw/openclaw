import { expect, it } from "vitest";
import { countProviderBranches } from "../../scripts/check-provider-branching-ratchet.mts";

it.each([
  ['if (provider === "zai") {', 1],
  ["const native = model.api !== `openai-responses`;", 1],
  ['endpointClass === "openrouter" || endpointClass === "together"', 1],
  ["const lean = isLocalModelLeanEnabled(config);", 1],
  ["if (capabilities.usesExplicitProxyLikeEndpoint) {", 1],
  ['case "anthropic-messages":', 1],
  ['modelId.startsWith("claude-")', 1],
  ["isNativeOpenAIEndpoint(model)", 1],
  ["compat.supportsPromptCacheKey === true", 0],
  ["supportsClaudeAdaptiveThinking(model)", 1],
  ["if (policy.preserveSignatures) {", 0],
  ["provider === expectedProvider", 0],
])("counts %s as %i branch", (line, count) => {
  expect(countProviderBranches(line)).toBe(count);
});

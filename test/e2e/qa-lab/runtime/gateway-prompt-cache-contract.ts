import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const GATEWAY_PROMPT_CACHE_FILE =
  "test/e2e/qa-lab/runtime/gateway-prompt-cache.live.test.ts";
export const GATEWAY_PROMPT_CACHE_SCENARIOS = ["text-followup", "dependent-reads"] as const;

const DAILY_MODELS = [
  { provider: "openai", id: "gpt-5.6-luna", thinking: "low", maxOutputTokens: 4096 },
  { provider: "anthropic", id: "claude-sonnet-5", thinking: "low", maxOutputTokens: 4096 },
  { provider: "anthropic", id: "claude-fable-5-1", thinking: "low", maxOutputTokens: 4096 },
] as const;
const EXPANDED_MODELS = [
  ...DAILY_MODELS,
  // Astra requires reasoning; "none" is not a valid request for this model.
  { provider: "openai", id: "gpt-6-astra", thinking: "low", maxOutputTokens: 8192 },
  { provider: "anthropic", id: "claude-opus-5", thinking: "low", maxOutputTokens: 8192 },
] as const;

export type PromptCacheModel = (typeof EXPANDED_MODELS)[number];
export type PromptCacheScenario = (typeof GATEWAY_PROMPT_CACHE_SCENARIOS)[number];

export function gatewayPromptCacheModels(profile = "daily"): readonly PromptCacheModel[] {
  if (profile === "daily") {
    return DAILY_MODELS;
  }
  if (profile === "expanded") {
    return EXPANDED_MODELS;
  }
  throw new Error("Runtime cache profile must be daily or expanded.");
}

export function gatewayPromptCacheCaseId(model: PromptCacheModel, scenario: PromptCacheScenario) {
  return `${model.provider}/${model.id}: ${scenario}`;
}

/** A green aggregate cannot stand in for one missing, duplicated, or skipped matrix cell. */
export function validateGatewayPromptCacheAssertions(assertions: unknown[], profile = "daily") {
  const expected = gatewayPromptCacheModels(profile).flatMap((model) =>
    GATEWAY_PROMPT_CACHE_SCENARIOS.map((scenario) => gatewayPromptCacheCaseId(model, scenario)),
  );
  const cases = assertions.filter(
    (value) => isRecord(value) && value.title !== "disabled runtime cache opt-in",
  );
  if (
    cases.length !== expected.length ||
    expected.some(
      (title) =>
        cases.filter(
          (value) => isRecord(value) && value.title === title && value.status === "passed",
        ).length !== 1,
    )
  ) {
    return {
      ok: false,
      reason: `Runtime cache proof requires all ${expected.length} unique ${profile} scenarios to pass.`,
    };
  }
  return { ok: true };
}

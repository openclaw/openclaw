import { MODEL_CATALOG_THINKING_LEVELS } from "@openclaw/model-catalog-core/model-catalog-types";
import type { ProviderThinkingProfile } from "../plugins/provider-thinking.types.js";
export {
  isGoogleGemini3FlashModel,
  isGoogleGemini3ProModel,
  isGoogleGemini3ThinkingLevelModel,
} from "@openclaw/ai/internal/google-model-family";

// Provider policies load eagerly; keep this module free of streaming runtime imports.
export function resolveEffortThinkingProfile(
  efforts: readonly string[] | null | undefined,
): ProviderThinkingProfile | undefined {
  if (!efforts || efforts.length === 0) {
    return undefined;
  }
  const acceptedLevelIds = new Set([
    "off",
    ...efforts.map((effort) => (effort === "none" ? "off" : effort)),
  ]);
  const levels = MODEL_CATALOG_THINKING_LEVELS.filter((id) => acceptedLevelIds.has(id)).map(
    (id) => ({
      id,
    }),
  );
  const defaultLevel = acceptedLevelIds.has("medium")
    ? "medium"
    : acceptedLevelIds.has("high")
      ? "high"
      : acceptedLevelIds.has("low")
        ? "low"
        : "off";
  return { levels, defaultLevel };
}

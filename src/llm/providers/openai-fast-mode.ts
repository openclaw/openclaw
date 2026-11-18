import { resolveOpenAIResponsesPayloadPolicy } from "@openclaw/ai/internal/openai-responses-payload-policy";
import { normalizeFastMode } from "@openclaw/normalization-core/string-coerce";

export {
  normalizeOpenAIServiceTier,
  type OpenAIServiceTier,
} from "@openclaw/ai/internal/openai-responses-payload-policy";

export type OpenAIFastMode = boolean | "ultrafast";

export function normalizeOpenAIFastMode(value: unknown): OpenAIFastMode | undefined {
  if (typeof value === "function") {
    // SAFETY: typeof proves callable; the callback result remains unknown until normalized.
    return normalizeOpenAIFastMode((value as () => unknown)());
  }
  const fastMode = normalizeFastMode(value);
  return fastMode === "auto" ? undefined : fastMode;
}

export function supportsOpenAIResponsesFastMode(model: {
  provider: string;
  api?: string;
  baseUrl?: string;
}): boolean {
  return (
    model.provider === "openai" &&
    (model.api === "openai-responses" ||
      model.api === "openai-chatgpt-responses" ||
      model.api === "azure-openai-responses") &&
    resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" }).allowsServiceTier
  );
}

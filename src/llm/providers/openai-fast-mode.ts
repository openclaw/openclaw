import { resolveOpenAIResponsesPayloadPolicy } from "@openclaw/ai/internal/openai-responses-payload-policy";
import {
  normalizeFastMode,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";

export type OpenAIFastMode = boolean | "ultrafast";

export function normalizeOpenAIFastMode(value: unknown): OpenAIFastMode | undefined {
  if (typeof value === "function") {
    // SAFETY: typeof proves callable; the callback result remains unknown until normalized.
    return normalizeOpenAIFastMode((value as () => unknown)());
  }
  const fastMode = normalizeFastMode(value);
  return fastMode === "auto" ? undefined : fastMode;
}

export type OpenAIServiceTier = "auto" | "default" | "flex" | "priority" | "ultrafast";

export function normalizeOpenAIServiceTier(value: unknown): OpenAIServiceTier | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "auto" ||
    normalized === "default" ||
    normalized === "flex" ||
    normalized === "priority" ||
    normalized === "ultrafast"
    ? normalized
    : undefined;
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

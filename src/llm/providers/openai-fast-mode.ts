import { resolveOpenAIResponsesPayloadPolicy } from "@openclaw/ai/internal/openai-responses-payload-policy";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

export type OpenAIServiceTier = "auto" | "default" | "flex" | "priority";

export function normalizeOpenAIServiceTier(value: unknown): OpenAIServiceTier | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "auto" ||
    normalized === "default" ||
    normalized === "flex" ||
    normalized === "priority"
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

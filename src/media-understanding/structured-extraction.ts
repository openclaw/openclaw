/**
 * Shared structured-extraction prompt and result helpers used by the generic
 * model-backed fallback and by providers with native extraction turns.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { StructuredExtractionRequest, StructuredExtractionResult } from "./types.js";

/** Builds the instruction prompt for a structured extraction turn. */
export function buildStructuredExtractionPrompt(
  req: Pick<StructuredExtractionRequest, "instructions" | "schemaName" | "jsonSchema" | "jsonMode">,
): string {
  return [
    req.instructions.trim(),
    req.schemaName ? `Schema name: ${req.schemaName}` : undefined,
    req.jsonSchema ? `JSON schema:\n${JSON.stringify(req.jsonSchema)}` : undefined,
    req.jsonMode === false
      ? "Return the extraction as concise text."
      : "Return valid JSON only. Do not wrap the JSON in Markdown fences.",
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

/**
 * Parses and schema-validates a structured extraction reply. `errorLabel`
 * prefixes failure messages so provider-native callers keep their existing
 * error contract. The schema validator is imported lazily because this module
 * is re-exported through the plugin-SDK media-understanding barrel, which many
 * provider modules value-import at load time.
 */
export async function normalizeStructuredExtractionResult(params: {
  text: string;
  model: string;
  provider: string;
  request: Pick<StructuredExtractionRequest, "jsonMode" | "jsonSchema">;
  errorLabel: string;
  validationCacheKey: string;
}): Promise<StructuredExtractionResult> {
  const result: StructuredExtractionResult = {
    text: params.text,
    model: params.model,
    provider: params.provider,
    contentType: params.request.jsonMode === false ? "text" : "json",
  };
  if (params.request.jsonMode !== false) {
    try {
      result.parsed = JSON.parse(params.text);
    } catch {
      throw new Error(`${params.errorLabel} returned invalid JSON.`);
    }
    if (isRecord(params.request.jsonSchema)) {
      const { validateJsonSchemaValue } = await import("../plugins/schema-validator.js");
      const validation = validateJsonSchemaValue({
        schema: params.request.jsonSchema,
        cacheKey: params.validationCacheKey,
        value: result.parsed,
        cache: false,
      });
      if (!validation.ok) {
        const message = validation.errors.map((error) => error.text).join("; ") || "invalid";
        throw new Error(`${params.errorLabel} JSON did not match schema: ${message}`);
      }
      result.parsed = validation.value;
    }
  }
  return result;
}

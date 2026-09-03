// Model-backed structured extraction for image-capable providers without a
// bespoke hook: the same shared completion path describeImage/describeImages
// fall back to, with the extraction instructions pinned to the system channel.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProviderStreamOptions } from "../llm/types.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { completeImagesWithModel } from "./image.js";
import type {
  StructuredExtractionImageInput,
  StructuredExtractionRequest,
  StructuredExtractionResult,
  StructuredExtractionTextInput,
} from "./types.js";

/**
 * Mirrors the developer instruction the bundled Codex extractor sets. Logbook
 * feeds full screen captures through here and persists the result, so the
 * shared path must not be the weaker boundary: completeImagesWithModel refuses
 * routes that cannot carry this in the system channel.
 */
const STRUCTURED_EXTRACTION_INSTRUCTIONS =
  "You are OpenClaw's bounded structured-extraction worker. Return only the requested extraction. Do not include secrets such as passwords, API keys, tokens, or credentials, even when they are visible in the input.";

function isStructuredImageInput(
  entry: StructuredExtractionRequest["input"][number],
): entry is StructuredExtractionImageInput {
  return entry.type === "image";
}

function isStructuredTextInput(
  entry: StructuredExtractionRequest["input"][number],
): entry is StructuredExtractionTextInput {
  return entry.type === "text";
}

function buildStructuredExtractionPrompt(req: StructuredExtractionRequest): string {
  return [
    STRUCTURED_EXTRACTION_INSTRUCTIONS,
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

function parseStructuredExtraction(params: {
  text: string;
  model: string;
  req: StructuredExtractionRequest;
}): StructuredExtractionResult {
  const { req } = params;
  const result: StructuredExtractionResult = {
    text: params.text,
    model: params.model,
    provider: req.provider,
    contentType: req.jsonMode === false ? "text" : "json",
  };
  if (req.jsonMode === false) {
    return result;
  }
  try {
    result.parsed = JSON.parse(params.text);
  } catch {
    throw new Error(`Structured extraction returned invalid JSON: ${req.provider}`);
  }
  if (isRecord(req.jsonSchema)) {
    const validation = validateJsonSchemaValue({
      schema: req.jsonSchema,
      cacheKey: "media-understanding.extractStructured",
      value: result.parsed,
      cache: false,
    });
    if (!validation.ok) {
      const message = validation.errors.map((error) => error.text).join("; ") || "invalid";
      throw new Error(
        `Structured extraction JSON did not match schema: ${req.provider}: ${message}`,
      );
    }
    result.parsed = validation.value;
  }
  return result;
}

async function runStructuredExtraction(
  req: StructuredExtractionRequest,
  onPayload?: ProviderStreamOptions["onPayload"],
): Promise<StructuredExtractionResult> {
  const model = req.model.trim();
  if (!model) {
    throw new Error("Structured extraction requires model id.");
  }
  if (!req.instructions.trim()) {
    throw new Error("Structured extraction requires instructions.");
  }
  const images = req.input.filter(isStructuredImageInput);
  if (images.length === 0) {
    throw new Error("Structured extraction requires at least one image input.");
  }
  req.signal?.throwIfAborted();
  const { text } = await completeImagesWithModel(
    {
      images: images.map((image) => ({
        buffer: image.buffer,
        fileName: image.fileName,
        mime: image.mime,
      })),
      model,
      provider: req.provider,
      prompt: buildStructuredExtractionPrompt(req),
      promptDelivery: "system-required",
      // Supplemental text is caller data: it rides in user content beside the images.
      userText: req.input
        .filter(isStructuredTextInput)
        .map((entry) => entry.text.trim())
        .filter(Boolean),
      timeoutMs: req.timeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
      profile: req.profile,
      preferredProfile: req.preferredProfile,
      authStore: req.authStore,
      agentDir: req.agentDir,
      cfg: req.cfg,
    },
    onPayload ? { onPayload } : {},
  );
  return parseStructuredExtraction({ text, model, req });
}

/** Extracts structured data from images through the shared model runtime. */
export async function extractStructuredWithImageModelCore(
  req: StructuredExtractionRequest,
): Promise<StructuredExtractionResult> {
  return await runStructuredExtraction(req);
}

/** Extracts structured data from images after applying the runtime payload transform. */
export async function extractStructuredWithImageModelPayloadTransformCore(
  req: StructuredExtractionRequest,
  onPayload: ProviderStreamOptions["onPayload"],
): Promise<StructuredExtractionResult> {
  return await runStructuredExtraction(req, onPayload);
}

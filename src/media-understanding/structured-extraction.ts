// Generic model-backed structured extraction. Any image-capable provider that
// does not ship a bespoke implementation routes through here, the same way
// describeImage/describeImages fall back to the shared image runtime.
//
// It runs on the provider's OWN describeImages when it has one. A provider can
// carry a transport-specific request transform there -- opencode strips an
// unsupported disabled-reasoning payload, for example -- and structured
// extraction has to honour it, otherwise the fallback would resend exactly the
// payload that hook exists to remove.
import { isMinimaxVlmModel } from "../agents/minimax-vlm.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { describeImagesWithModel } from "./image-runtime.js";
import type {
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
  StructuredExtractionImageInput,
  StructuredExtractionRequest,
  StructuredExtractionResult,
  StructuredExtractionTextInput,
} from "./types.js";

type DescribeImages = (req: ImagesDescriptionRequest) => Promise<ImagesDescriptionResult>;

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

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Routes whose image executor answers a MULTI-image request with one call per
 * image and joins the replies as `Image N:` text (see describeImagesWithMinimax
 * in image.ts). Structured extraction needs one JSON document for the whole
 * request, which a joined transcript can never be, so those routes keep the
 * dispatcher's explicit unsupported error instead of failing later at
 * JSON.parse with a message that blames the model.
 *
 * Deliberately scoped to multi-image requests only. The same executor returns
 * the model's bare text for a single image, with no `Image N:` prefix and no
 * "describe image N of M" prompt suffix, so single-image structured extraction
 * on these routes parses like any other provider and stays supported.
 */
function splitsMultiImageRequests(provider: string, model: string): boolean {
  return isMinimaxVlmModel(provider, model);
}

/** Builds the extraction prompt from instructions, schema, and any text inputs. */
function buildStructuredExtractionPrompt(req: StructuredExtractionRequest): string {
  const textInputs = req.input.filter(isStructuredTextInput).map((entry) => entry.text);
  return [
    req.instructions.trim(),
    req.schemaName ? `Schema name: ${req.schemaName}` : undefined,
    req.jsonSchema ? `JSON schema:\n${JSON.stringify(req.jsonSchema)}` : undefined,
    ...textInputs,
    req.jsonMode === false
      ? "Return the extraction as concise text."
      : "Return valid JSON only. Do not wrap the JSON in Markdown fences.",
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function normalizeStructuredExtractionResult(params: {
  text: string;
  model: string;
  provider: string;
  req: StructuredExtractionRequest;
}): StructuredExtractionResult {
  const result: StructuredExtractionResult = {
    text: params.text,
    model: params.model,
    provider: params.provider,
    contentType: params.req.jsonMode === false ? "text" : "json",
  };
  if (params.req.jsonMode === false) {
    return result;
  }
  try {
    result.parsed = JSON.parse(params.text);
  } catch {
    throw new Error(`Structured extraction returned invalid JSON: ${params.provider}`);
  }
  if (isJsonSchemaObject(params.req.jsonSchema)) {
    const validation = validateJsonSchemaValue({
      schema: params.req.jsonSchema,
      cacheKey: "media-understanding.extractStructured",
      value: result.parsed,
      cache: false,
    });
    if (!validation.ok) {
      const message = validation.errors.map((error) => error.text).join("; ") || "invalid";
      throw new Error(
        `Structured extraction JSON did not match schema: ${params.provider}: ${message}`,
      );
    }
    result.parsed = validation.value;
  }
  return result;
}

/**
 * Builds a structured-extraction implementation bound to a specific
 * describeImages executor. The registry passes the provider's own hook when it
 * has one, so a provider's request transform survives structured extraction.
 */
export function createStructuredExtractionWithImageModel(
  describeImages: DescribeImages,
): (req: StructuredExtractionRequest) => Promise<StructuredExtractionResult> {
  return (req) => runStructuredExtraction(req, describeImages);
}

/**
 * Runs structured extraction through the generic model runtime. Mirrors the
 * bundled Codex provider's prompt-build + parse + validate flow, but reuses the
 * provider-agnostic image pipeline instead of a provider-specific transport.
 */
export async function extractStructuredWithImageModel(
  req: StructuredExtractionRequest,
): Promise<StructuredExtractionResult> {
  return await runStructuredExtraction(req, describeImagesWithModel);
}

async function runStructuredExtraction(
  req: StructuredExtractionRequest,
  describeImages: DescribeImages,
): Promise<StructuredExtractionResult> {
  const model = req.model.trim();
  if (!model) {
    throw new Error("Structured extraction requires model id.");
  }
  const instructions = req.instructions.trim();
  if (!instructions) {
    throw new Error("Structured extraction requires instructions.");
  }
  if (req.input.length === 0) {
    throw new Error("Structured extraction requires at least one input.");
  }
  const images = req.input.filter(isStructuredImageInput);
  if (images.length === 0) {
    throw new Error("Structured extraction requires at least one image input.");
  }
  // Refuse before spending any provider call, and with the same message the
  // dispatcher used before this fallback existed, so a split-response route is
  // unchanged rather than newly broken at the JSON parser.
  if (images.length > 1 && splitsMultiImageRequests(req.provider, model)) {
    throw new Error(`Provider does not support structured extraction: ${req.provider}`);
  }
  req.signal?.throwIfAborted();

  const { text } = await describeImages({
    images: images.map((image) => ({
      buffer: image.buffer,
      fileName: image.fileName,
      mime: image.mime,
    })),
    model,
    provider: req.provider,
    prompt: buildStructuredExtractionPrompt(req),
    timeoutMs: req.timeoutMs,
    ...(req.signal ? { signal: req.signal } : {}),
    profile: req.profile,
    preferredProfile: req.preferredProfile,
    authStore: req.authStore,
    agentDir: req.agentDir,
    cfg: req.cfg,
  });

  return normalizeStructuredExtractionResult({
    text,
    model,
    provider: req.provider,
    req,
  });
}

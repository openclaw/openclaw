/**
 * Generic model-backed structured extraction used when a media-understanding
 * provider supplies no native `extractStructured` hook — the structured
 * sibling of the shared image-description fallback.
 */
import { describeImagesWithModelCore } from "./image.js";
import {
  buildStructuredExtractionPrompt,
  normalizeStructuredExtractionResult,
} from "./structured-extraction.js";
import type { StructuredExtractionRequest, StructuredExtractionResult } from "./types.js";

/** Runs structured extraction through the shared image-description model path. */
export async function extractStructuredWithModelFallbackCore(
  req: StructuredExtractionRequest,
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
  const images = req.input.filter((entry) => entry.type === "image");
  if (images.length === 0) {
    throw new Error("Structured extraction requires at least one image input.");
  }
  // The shared image path takes one prompt string, so supplemental text inputs
  // fold into it in order (providers with native turns keep them as separate
  // content parts — equivalent context, different framing).
  const prompt = [
    buildStructuredExtractionPrompt(req),
    ...req.input.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])),
  ].join("\n\n");
  const description = await describeImagesWithModelCore({
    images: images.map((entry) => ({
      buffer: entry.buffer,
      fileName: entry.fileName,
      mime: entry.mime,
    })),
    provider: req.provider,
    model,
    prompt,
    timeoutMs: req.timeoutMs,
    ...(req.signal ? { signal: req.signal } : {}),
    profile: req.profile,
    preferredProfile: req.preferredProfile,
    authStore: req.authStore,
    agentDir: req.agentDir,
    cfg: req.cfg,
  });
  return await normalizeStructuredExtractionResult({
    text: description.text,
    model: description.model ?? model,
    provider: req.provider,
    request: req,
    errorLabel: "Structured extraction",
    validationCacheKey: "media-understanding.extractStructured",
  });
}

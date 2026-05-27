import { parseGenerationModelRef } from "../media-generation/model-ref.js";

export function parseImageGenerationModelRef(
  raw: string | undefined,
): { provider: string; model: string } | null {
  return parseGenerationModelRef(raw);
}

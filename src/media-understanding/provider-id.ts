import { normalizeProviderId } from "../agents/provider-id.js";

/**
 * Normalize a provider ID for media-understanding registry lookups.
 *
 * Provider variants that share the same underlying API and model catalog
 * are collapsed to their base provider so a single media-understanding
 * adapter can serve all of them:
 *
 * - `"gemini"` → `"google"`
 * - `"openai-codex"` → `"openai"` (Codex OAuth uses the same OpenAI vision models)
 * - `"github-copilot"` → `"openai"` (Copilot routes through OpenAI models)
 */
export function normalizeMediaProviderId(id: string): string {
  const normalized = normalizeProviderId(id);
  if (normalized === "gemini") {
    return "google";
  }
  if (normalized === "openai-codex" || normalized === "github-copilot") {
    return "openai";
  }
  return normalized;
}

import { normalizeOptionalLowercaseString } from "./shared/string-coerce.js";

/**
 * Per-session emotion mode.
 *
 * - `off`: no expressive layer is exposed. Replies are treated as plain text;
 *   visible chat, history snapshots, and TTS source text use sanitized text.
 * - `on`: the agent may emit ElevenLabs v3 expressive tags (e.g. `[whisper]`).
 *   Visible chat and persisted history are sanitized; tag-aware TTS providers
 *   receive the unsanitized variant via `ReplyPayloadMetadata.ttsSourceText`.
 * - `full`: as `on`, but visible chat and history retain the expressive tags
 *   (operator-facing debug / playthrough mode).
 */
export type EmotionMode = "off" | "on" | "full";

export function normalizeEmotionMode(value: unknown): EmotionMode | undefined {
  const normalized =
    typeof value === "string" ? normalizeOptionalLowercaseString(value) : undefined;
  if (normalized === "off" || normalized === "on" || normalized === "full") {
    return normalized;
  }
  return undefined;
}

export function isEmotionModeEnabled(mode: EmotionMode | undefined): boolean {
  return mode === "on" || mode === "full";
}

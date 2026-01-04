/**
 * Extract audio mode tag from text.
 * Supports [[audio_as_file]] to send audio as file instead of voice bubble.
 */
export function extractAudioTag(text?: string): {
  cleaned: string;
  audioAsVoice: boolean;
  hasTag: boolean;
} {
  if (!text) return { cleaned: "", audioAsVoice: true, hasTag: false };
  let cleaned = text;
  let audioAsVoice = true; // default: voice bubble
  let hasTag = false;

  // [[audio_as_file]] -> send as file with metadata, not voice bubble
  const fileMatch = cleaned.match(/\[\[audio_as_file\]\]/i);
  if (fileMatch) {
    cleaned = cleaned.replace(/\[\[audio_as_file\]\]/gi, " ");
    audioAsVoice = false;
    hasTag = true;
  }

  // Clean up whitespace
  cleaned = cleaned
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();

  return { cleaned, audioAsVoice, hasTag };
}

/**
 * Extract audio mode tag from text.
 * Supports [[audio_as_voice]] to send audio as voice bubble instead of file.
 * Default is file (preserves backward compatibility).
 */
export function parseAudioTag(text?: string): {
  text: string;
  audioAsVoice: boolean;
  hadTag: boolean;
} {
  if (!text) return { text: "", audioAsVoice: false, hadTag: false };
  let cleaned = text;
  let audioAsVoice = false; // default: audio file (backward compatible)
  let hadTag = false;

  // [[audio_as_voice]] -> send as voice bubble (opt-in)
  const voiceMatch = cleaned.match(/\[\[audio_as_voice\]\]/i);
  if (voiceMatch) {
    cleaned = cleaned.replace(/\[\[audio_as_voice\]\]/gi, " ");
    audioAsVoice = true;
    hadTag = true;
  }

  // Clean up whitespace
  cleaned = cleaned
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();

  return { text: cleaned, audioAsVoice, hadTag };
}

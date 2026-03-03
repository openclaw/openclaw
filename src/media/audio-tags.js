import { parseInlineDirectives } from "../utils/directive-tags.js";
/**
 * Extract audio mode tag from text.
 * Supports [[audio_as_voice]] to send audio as voice bubble instead of file.
 * Default is file (preserves backward compatibility).
 */
export function parseAudioTag(text) {
    const result = parseInlineDirectives(text, { stripReplyTags: false });
    return {
        text: result.text,
        audioAsVoice: result.audioAsVoice,
        hadTag: result.hasAudioTag,
    };
}

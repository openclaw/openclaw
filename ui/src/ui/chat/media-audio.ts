/**
 * Helpers to parse MEDIA: audio paths from message/tool text and build playable URLs
 * for the gateway dashboard (serves files under tmp via /api/media/by-path).
 */

const MEDIA_LINE_RE = /^\s*MEDIA:\s*`?([^\n`]+)`?\s*$/;
const AUDIO_EXT_RE = /\.(mp3|wav|opus)$/i;

export function getMediaBaseUrl(): string {
  if (typeof globalThis === "undefined") return "";
  const g = globalThis as unknown as { location?: { origin: string } };
  return g.location?.origin ?? "";
}

function toPlayableUrl(path: string, baseUrl: string): string {
  const trimmed = path.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!baseUrl) return "";
  return `${baseUrl}/api/media/by-path?path=${encodeURIComponent(trimmed)}`;
}

/** Returns the first MEDIA: audio (mp3/wav/opus) playable URL in text, or null. */
export function getFirstMediaAudioUrl(text: string | undefined, baseUrl: string): string | null {
  if (!text?.trim()) return null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(MEDIA_LINE_RE);
    if (m) {
      const path = m[1].trim();
      if (AUDIO_EXT_RE.test(path)) {
        const url = toPlayableUrl(path, baseUrl);
        if (url) return url;
      }
    }
  }
  return null;
}

export type MessageSegment = { type: "text"; content: string } | { type: "audio"; playableUrl: string };

/** Splits text into segments, extracting MEDIA: audio lines as audio segments. */
export function parseTextWithMedia(text: string, baseUrl: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const lines = text.split(/\r?\n/);
  let currentText: string[] = [];

  for (const line of lines) {
    const m = line.match(MEDIA_LINE_RE);
    if (m) {
      const path = m[1].trim();
      if (AUDIO_EXT_RE.test(path)) {
        if (currentText.length > 0) {
          segments.push({ type: "text", content: currentText.join("\n") });
          currentText = [];
        }
        const playableUrl = toPlayableUrl(path, baseUrl);
        if (playableUrl) {
          segments.push({ type: "audio", playableUrl });
        }
      } else {
        currentText.push(line);
      }
    } else {
      currentText.push(line);
    }
  }
  if (currentText.length > 0) {
    segments.push({ type: "text", content: currentText.join("\n") });
  }
  return segments;
}

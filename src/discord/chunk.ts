export type ChunkDiscordTextOpts = {
  /** Max characters per Discord message. Default: 2000. */
  maxChars?: number;
  /**
   * Soft max line count per message.
   *
   * Discord clients can "clip"/collapse very tall messages in the UI; splitting
   * by lines keeps long multi-paragraph replies readable.
   */
  maxLines?: number;
};

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_LINES = 20;

function countLines(text: string) {
  if (!text) return 0;
  return text.split("\n").length;
}

function isFenceLine(line: string) {
  return line.trim().startsWith("```");
}

function splitLongLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const out: string[] = [];
  let remaining = line;
  while (remaining.length > maxChars) {
    out.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars);
  }
  if (remaining.length) out.push(remaining);
  return out;
}

function closeFenceIfNeeded(text: string, fenceOpen: string | null) {
  if (!fenceOpen) return text;
  if (!text.endsWith("\n")) return `${text}\n\`\`\``;
  return `${text}\`\`\``;
}

/**
 * Chunks outbound Discord text by both character count and (soft) line count,
 * while keeping fenced code blocks balanced across chunks.
 */
export function chunkDiscordText(
  text: string,
  opts: ChunkDiscordTextOpts = {},
): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;

  const trimmed = text ?? "";
  if (!trimmed) return [];

  const alreadyOk =
    trimmed.length <= maxChars && countLines(trimmed) <= maxLines;
  if (alreadyOk) return [trimmed];

  const lines = trimmed.split("\n");
  const chunks: string[] = [];

  let current = "";
  let currentLines = 0;
  let openFence: string | null = null;

  const flush = () => {
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length) chunks.push(payload);
    current = "";
    currentLines = 0;
    if (openFence) {
      current = openFence;
      currentLines = 1;
    }
  };

  for (const originalLine of lines) {
    if (isFenceLine(originalLine)) {
      openFence = openFence ? null : originalLine;
    }

    const segments = splitLongLine(originalLine, maxChars);
    for (let segIndex = 0; segIndex < segments.length; segIndex++) {
      const segment = segments[segIndex];
      const isLineContinuation = segIndex > 0;
      const delimiter = isLineContinuation
        ? ""
        : current.length > 0
          ? "\n"
          : "";
      const addition = `${delimiter}${segment}`;
      const nextLen = current.length + addition.length;
      const nextLines = currentLines + (isLineContinuation ? 0 : 1);

      const wouldExceedChars = nextLen > maxChars;
      const wouldExceedLines = nextLines > maxLines;

      if ((wouldExceedChars || wouldExceedLines) && current.length > 0) {
        flush();
      }

      if (current.length > 0) {
        current += addition;
        if (!isLineContinuation) currentLines += 1;
      } else {
        current = segment;
        currentLines = 1;
      }
    }
  }

  if (current.length) {
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length) chunks.push(payload);
  }

  return chunks;
}

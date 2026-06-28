import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";

type ToolResultContentBlock = Record<string, unknown>;

function stringifyStructuredBlock(block: ToolResultContentBlock): string | undefined {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(block, (_key, value) => {
      if (typeof value === "string") {
        return value.replace(
          /data:[^"'\\\s]+/gi,
          (match) => `[inline data URI: ${match.length} chars]`,
        );
      }
      if (!value || typeof value !== "object") {
        return value;
      }
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
      return value;
    });
    if (!serialized || serialized === "{}") {
      return undefined;
    }
    return serialized.length > 1_000
      ? `${serialized.slice(0, 1_000)}... (${serialized.length} chars)`
      : serialized;
  } catch {
    return undefined;
  }
}

export function extractToolResultText(blocks: readonly ToolResultContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type === "image") {
      continue;
    }
    if (block.type === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (text) {
        parts.push(text);
      }
      continue;
    }
    const structured = stringifyStructuredBlock(block);
    if (structured) {
      parts.push(structured);
    }
  }
  return sanitizeSurrogates(parts.join("\n"));
}

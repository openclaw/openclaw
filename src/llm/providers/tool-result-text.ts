import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";

function stringifyStructuredBlock(block: Record<string, unknown>): string | undefined {
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
    // Keep provider conversion lossless; context/tool-result guards own payload budgeting.
    return serialized;
  } catch {
    return undefined;
  }
}

export function extractToolResultText(blocks: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "image") {
      continue;
    }
    if (record.type === "text") {
      const text = typeof record.text === "string" ? record.text : "";
      if (text) {
        parts.push(text);
      }
      continue;
    }
    const structured = stringifyStructuredBlock(record);
    if (structured) {
      parts.push(structured);
    }
  }
  return sanitizeSurrogates(parts.join("\n"));
}

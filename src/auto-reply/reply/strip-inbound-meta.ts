/**
 * Strips OpenClaw-injected inbound metadata blocks from a user-role message
 * text before it is displayed in any UI surface (TUI, webchat, macOS app).
 *
 * Background: `buildInboundUserContextPrefix` in `inbound-meta.ts` prepends
 * structured metadata blocks (Conversation info, Sender info, reply context,
 * etc.) directly to the stored user message content so the LLM can access
 * them. These blocks are AI-facing only and must never surface in user-visible
 * chat history.
 */

/**
 * Sentinel strings that identify the start of an injected metadata block.
 * Must stay in sync with `buildInboundUserContextPrefix` in `inbound-meta.ts`.
 */
const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

// Pre-compiled fast-path regex — avoids line-by-line parse when no blocks present.
const SENTINEL_FAST_RE = new RegExp(
  INBOUND_META_SENTINELS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
);

/**
 * Remove all injected inbound metadata prefix blocks from `text`.
 *
 * Each block has the shape:
 *
 * ```
 * <sentinel-line>
 * ```json
 * { … }
 * ```
 * ```
 *
 * Returns the original string reference unchanged when no metadata is present
 * (fast path — zero allocation).
 */
export function stripInboundMetadata(text: string): string {
  if (!text || !SENTINEL_FAST_RE.test(text)) {
    return text;
  }

  const lines = text.split("\n");
  const result: string[] = [];
  let inMetaBlock = false;
  let inFencedJson = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of a metadata block.
    if (!inMetaBlock && INBOUND_META_SENTINELS.some((s) => line.startsWith(s))) {
      inMetaBlock = true;
      inFencedJson = false;
      continue;
    }

    if (inMetaBlock) {
      if (!inFencedJson && line.trim() === "```json") {
        inFencedJson = true;
        continue;
      }
      if (inFencedJson) {
        if (line.trim() === "```") {
          inMetaBlock = false;
          inFencedJson = false;
        }
        continue;
      }
      // Blank separator lines between consecutive blocks are dropped.
      if (line.trim() === "") {
        continue;
      }
      // Unexpected non-blank line outside a fence — treat as user content.
      inMetaBlock = false;
    }

    result.push(line);
  }

  return result.join("\n").replace(/^\n+/, "");
}

export function stripLeadingInboundMetadata(text: string): string {
  if (!text || !SENTINEL_FAST_RE.test(text)) {
    return text;
  }

  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length && lines[index] === "") {
    index++;
  }
  if (index >= lines.length) {
    return "";
  }

  if (!INBOUND_META_SENTINELS.some((s) => lines[index].startsWith(s))) {
    return text;
  }

  while (index < lines.length) {
    const line = lines[index];
    if (!INBOUND_META_SENTINELS.some((s) => line.startsWith(s))) {
      break;
    }

    index++;
    if (index < lines.length && lines[index].trim() === "```json") {
      index++;
      while (index < lines.length && lines[index].trim() !== "```") {
        index++;
      }
      if (index < lines.length && lines[index].trim() === "```") {
        index++;
      }
    } else {
      return text;
    }

    while (index < lines.length && lines[index].trim() === "") {
      index++;
    }
  }

  return lines.slice(index).join("\n");
}

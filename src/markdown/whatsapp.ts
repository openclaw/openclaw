import { escapeRegExp } from "../utils.js";
/**
 * Convert standard Markdown formatting to WhatsApp-compatible markup.
 *
 * WhatsApp uses its own formatting syntax:
 *   bold:          *text*
 *   italic:        _text_
 *   strikethrough: ~text~
 *   monospace:     ```text```
 *
 * Standard Markdown uses:
 *   bold:          **text** or __text__
 *   italic:        *text* or _text_
 *   strikethrough: ~~text~~
 *   code:          `text` (inline) or ```text``` (block)
 *
 * The conversion preserves fenced code blocks and inline code,
 * then converts bold and strikethrough markers.
 */

/** Placeholder tokens used during conversion to protect code spans. */
const FENCE_PLACEHOLDER = "\x00FENCE";
const INLINE_CODE_PLACEHOLDER = "\x00CODE";

/**
 * Convert standard Markdown bold/italic/strikethrough to WhatsApp formatting.
 *
 * Order of operations matters:
 * 1. Protect fenced code blocks (```...```) — already WhatsApp-compatible
 * 2. Protect inline code (`...`) — leave as-is
 * 3. Strip markdown headers → bold (before bold conversion to avoid nesting)
 * 4. Convert **bold** → *bold* and __bold__ → *bold*
 * 5. Convert ~~strike~~ → ~strike~
 * 6-7. Restore protected spans
 *
 * Italic *text* and _text_ are left alone since WhatsApp uses _text_ for italic
 * and single * is already WhatsApp bold — no conversion needed for single markers.
 */
export function markdownToWhatsApp(text: string): string {
  if (!text) {
    return text;
  }

  // 1. Extract and protect fenced code blocks
  const fences: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    fences.push(match);
    return `${FENCE_PLACEHOLDER}${fences.length - 1}`;
  });

  // 2. Extract and protect inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`[^`\n]+`/g, (match) => {
    inlineCodes.push(match);
    return `${INLINE_CODE_PLACEHOLDER}${inlineCodes.length - 1}`;
  });

  // 3. Strip markdown headers FIRST (before bold/strikethrough conversion)
  // so that inner markers like **bold** are still intact for step 4.
  // e.g. "## Header **bold**" → "*Header **bold***" → "*Header *bold**" (wrong)
  // With this order: "## Header **bold**" → "*Header **bold***" then bold
  // conversion only touches the inner **: "*Header *bold**" — still wrong.
  // Instead, convert header content bold markers inline:
  result = result.replace(/^#{1,6}\s+(.+)$/gm, (_match, content: string) => {
    let c = content.replace(/\*\*(.+?)\*\*/g, "$1");
    c = c.replace(/__(.+?)__/g, "$1");
    return `*${c}*`;
  });

  // 4. Convert **bold** → *bold* and __bold__ → *bold*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");

  // 5. Convert ~~strikethrough~~ → ~strikethrough~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // 6. Restore inline code
  result = result.replace(
    new RegExp(`${escapeRegExp(INLINE_CODE_PLACEHOLDER)}(\\d+)`, "g"),
    (_, idx) => inlineCodes[Number(idx)] ?? "",
  );

  // 7. Restore fenced code blocks
  result = result.replace(
    new RegExp(`${escapeRegExp(FENCE_PLACEHOLDER)}(\\d+)`, "g"),
    (_, idx) => fences[Number(idx)] ?? "",
  );

  return result;
}

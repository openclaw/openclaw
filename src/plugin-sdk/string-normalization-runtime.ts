/**
 * Browser-safe string normalization and literal chat display.
 */
export { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
export {
  containsAsciiControlCharacter,
  normalizeAtHashSlug,
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "../../packages/normalization-core/src/string-normalization.js";
export { escapeChatDisplayText, sanitizeChatDisplayText } from "../shared/text/chat-display.js";
export { shellEscape, shellEscapeBackslash } from "../shared/shell-quote.js";

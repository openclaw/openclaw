/**
 * Browser-safe string normalization and literal chat display.
 */
export {
  containsAsciiControlCharacter,
  normalizeAtHashSlug,
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "../../packages/normalization-core/src/string-normalization.js";
export { escapeChatDisplayText, sanitizeChatDisplayText } from "../shared/text/chat-display.js";

// Narrow text/shared helpers for extensions that should not pull the full
// text-runtime aggregator into mixed runtime/Jiti loader paths.

export { redactSensitiveText } from "../logging/redact.js";
export {
  chunkMarkdownIR,
  markdownToIR,
  type MarkdownIR,
  type MarkdownLinkSpan,
} from "../markdown/ir.js";
export { renderMarkdownWithMarkers } from "../markdown/render.js";
export { resolveGlobalMap, resolveGlobalSingleton } from "../shared/global-singleton.js";
export {
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "../shared/string-normalization.js";
export {
  FILE_REF_EXTENSIONS_WITH_TLD,
  isAutoLinkedFileRef,
} from "../shared/text/auto-linked-file-ref.js";
export { findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";
export { stripReasoningTagsFromText } from "../shared/text/reasoning-tags.js";
export { isRecord } from "../utils.js";
export { chunkItems } from "../utils/chunk-items.js";
export { fetchWithTimeout } from "../utils/fetch-timeout.js";
export {
  resolveReactionLevel,
  type ReactionLevel,
  type ResolvedReactionLevel,
} from "../utils/reaction-level.js";
export { withTimeout } from "../utils/with-timeout.js";

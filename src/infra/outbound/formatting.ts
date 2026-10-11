// Formatting options carried through outbound planning control text chunking,
// table rendering, markdown handling, and parse mode.
import type { MarkdownTableMode, TextChunkMode } from "../../config/types.base.js";

/**
 * Formatting and chunking hints carried through outbound delivery planning.
 */
export type OutboundDeliveryFormattingOptions = {
  textLimit?: number;
  maxLinesPerMessage?: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: TextChunkMode;
  parseMode?: "HTML";
};

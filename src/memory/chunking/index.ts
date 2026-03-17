/**
 * Chunking module for memory segmentation.
 *
 * This module provides a modular, extensible approach to chunking
 * markdown content for memory indexing.
 *
 * @example
 * ```ts
 * import { chunkMarkdown } from "./chunking";
 *
 * const chunks = chunkMarkdown(content, {
 *   maxBytes: 2000,
 *   overlapBytes: 200,
 * });
 * ```
 */

// Re-export for convenience
export * from "./chunk-strategy.js";
export * from "./simple-chunker.js";
export * from "./semantic-chunker.js";
export * from "./advanced-chunker.js";
export * from "./markdown-boundaries.js";

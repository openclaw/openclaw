/**
 * Advanced chunking strategy with enhanced metadata and relationships.
 *
 * Phase 3 features:
 * - Dynamic overlap based on content type
 * - Hierarchical context (chunk + section/chapter info)
 * - Cross-chunk references for retrieval enhancement
 */

import { estimateUtf8Bytes } from "../embedding-input-limits.js";
import { hashText, type MemoryChunk } from "../internal.js";
import type { ChunkStrategy, ChunkingConfig } from "./chunk-strategy.js";
import {
  findSplitPoints,
  findCodeBlocks,
  getLineRole,
  type LineRole,
  getHeadingLevel,
} from "./markdown-boundaries.js";
import { buildTextEmbeddingInput } from "../embedding-inputs.js";
import { semanticChunker } from "./semantic-chunker.js";

/**
 * Enhanced chunk with additional metadata.
 */
export type EnhancedMemoryChunk = MemoryChunk & {
  /**
   * Additional metadata about the chunk.
   */
  metadata: {
    /**
     * The most recent heading before this chunk (if any).
     */
    sectionHeading?: string;

    /**
     * The heading level (1-6) of the section.
     */
    sectionLevel?: number;

    /**
     * Whether this chunk contains code.
     */
    hasCode: boolean;

    /**
     * The content type of this chunk.
     */
    contentType: "heading" | "code" | "list" | "blockquote" | "prose" | "mixed";

    /**
     * References to adjacent chunks.
     */
    neighbors: {
      /**
       * Previous chunk index in the document.
       */
      previousChunkId?: string;

      /**
       * Next chunk index in the document.
       */
      nextChunkId?: string;

      /**
       * Parent section chunk (if this is a sub-section).
       */
      parentChunkId?: string;
    };
  };

  /**
   * Unique identifier for this chunk (enhanced hash).
   */
  chunkId: string;
};

/**
 * Dynamic overlap configuration based on content type.
 */
export type DynamicOverlapConfig = {
  /**
   * Base overlap in bytes.
   */
  baseOverlapBytes: number;

  /**
   * Overlap multiplier for code blocks (code needs more context).
   */
  codeOverlapMultiplier: number;

  /**
   * Overlap multiplier for headings.
   */
  headingOverlapMultiplier: number;

  /**
   * Overlap multiplier for lists.
   */
  listOverlapMultiplier: number;

  /**
   * Minimum overlap in bytes.
   */
  minOverlapBytes: number;

  /**
   * Maximum overlap in bytes.
   */
  maxOverlapBytes: number;
};

/**
 * Default dynamic overlap configuration.
 */
export const DEFAULT_DYNAMIC_OVERLAP: DynamicOverlapConfig = {
  baseOverlapBytes: 200,
  codeOverlapMultiplier: 1.5, // Code needs more context
  headingOverlapMultiplier: 0.5, // Headings are natural boundaries
  listOverlapMultiplier: 1.2, // Lists benefit from item context
  minOverlapBytes: 50,
  maxOverlapBytes: 1000,
};

/**
 * Calculate dynamic overlap based on content type.
 */
export function calculateDynamicOverlap(
  contentType: EnhancedMemoryChunk["metadata"]["contentType"],
  hasCode: boolean,
  config: DynamicOverlapConfig = DEFAULT_DYNAMIC_OVERLAP,
): number {
  // Merge with defaults to handle partial config
  const fullConfig: DynamicOverlapConfig = {
    baseOverlapBytes: config.baseOverlapBytes ?? DEFAULT_DYNAMIC_OVERLAP.baseOverlapBytes,
    codeOverlapMultiplier: config.codeOverlapMultiplier ?? DEFAULT_DYNAMIC_OVERLAP.codeOverlapMultiplier,
    headingOverlapMultiplier: config.headingOverlapMultiplier ?? DEFAULT_DYNAMIC_OVERLAP.headingOverlapMultiplier,
    listOverlapMultiplier: config.listOverlapMultiplier ?? DEFAULT_DYNAMIC_OVERLAP.listOverlapMultiplier,
    minOverlapBytes: config.minOverlapBytes ?? DEFAULT_DYNAMIC_OVERLAP.minOverlapBytes,
    maxOverlapBytes: config.maxOverlapBytes ?? DEFAULT_DYNAMIC_OVERLAP.maxOverlapBytes,
  };

  let overlap = fullConfig.baseOverlapBytes;

  // Apply multipliers based on content type
  switch (contentType) {
    case "code":
      overlap *= fullConfig.codeOverlapMultiplier;
      break;
    case "heading":
      overlap *= fullConfig.headingOverlapMultiplier;
      break;
    case "list":
      overlap *= fullConfig.listOverlapMultiplier;
      break;
    case "mixed":
      // Mixed content gets moderate multiplier
      overlap *= 1.1;
      break;
  }

  // Additional code bonus (apply after content type multiplier)
  if (hasCode && contentType !== "code") {
    // Already applied for code type, only add for other types
    overlap *= fullConfig.codeOverlapMultiplier;
  }

  // Ensure we have a valid number
  if (Number.isNaN(overlap) || !Number.isFinite(overlap)) {
    overlap = fullConfig.baseOverlapBytes;
  }

  // Clamp to min/max
  return Math.max(
    fullConfig.minOverlapBytes,
    Math.min(fullConfig.maxOverlapBytes, overlap),
  );
}

/**
 * Analyze content to determine its type.
 */
export function analyzeContentType(lines: string[]): EnhancedMemoryChunk["metadata"]["contentType"] {
  const roles = new Set<LineRole>();
  let hasCode = false;
  let hasList = false;
  let hasBlockquote = false;
  let hasHeading = false;
  let hasProse = false;

  for (const line of lines) {
    const role = getLineRole(line);
    roles.add(role);

    switch (role) {
      case "code_fence":
        hasCode = true;
        break;
      case "list_item":
        hasList = true;
        break;
      case "blockquote":
        hasBlockquote = true;
        break;
      case "heading":
        hasHeading = true;
        break;
      case "content":
        hasProse = true;
        break;
    }
  }

  // Determine dominant type
  if (roles.size === 1) {
    if (hasCode) return "code";
    if (hasList) return "list";
    if (hasBlockquote) return "blockquote";
    if (hasHeading) return "heading";
    if (hasProse) return "prose";
  }

  // Pure code block: only code_fence and content roles
  // (where content is the code inside the fence)
  if (roles.size === 2 && hasCode && hasProse && !hasList && !hasBlockquote && !hasHeading) {
    // Check if it's a wrapped code block (starts and ends with fence)
    const firstRole = getLineRole(lines[0] ?? "");
    const lastRole = getLineRole(lines[lines.length - 1] ?? "");
    if (firstRole === "code_fence" && lastRole === "code_fence") {
      return "code";
    }
    // Otherwise it's mixed (text before/after code block)
    return "mixed";
  }

  // Mixed content - multiple role types present
  if (hasCode) return "mixed"; // Code with other structure
  if (hasHeading && hasProse) return "mixed";
  if (hasList && hasProse && hasHeading) return "mixed";
  if (hasBlockquote && hasProse) return "mixed";
  if (hasHeading && hasList) return "mixed";
  if (hasList && hasProse) return "mixed"; // List + prose is mixed

  return "prose";
}

/**
 * Extract section heading from lines before the chunk.
 */
export function extractSectionHeading(
  allLines: string[],
  startIndex: number,
): { heading: string | undefined; level: number } {
  // Search backward for the nearest heading
  for (let i = startIndex - 1; i >= 0; i -= 1) {
    const line = allLines[i] ?? "";
    const level = getHeadingLevel(line);
    if (level > 0) {
      return { heading: line.trim(), level };
    }
  }
  return { heading: undefined, level: 0 };
}

/**
 * Advanced chunker implementation.
 */
export class AdvancedChunker implements ChunkStrategy {
  readonly name = "advanced";

  private dynamicOverlapConfig: DynamicOverlapConfig;
  private enableHierarchicalContext: boolean;
  private enableCrossReferences: boolean;

  constructor(options?: {
    dynamicOverlapConfig?: Partial<DynamicOverlapConfig>;
    enableHierarchicalContext?: boolean;
    enableCrossReferences?: boolean;
  }) {
    this.dynamicOverlapConfig = {
      ...DEFAULT_DYNAMIC_OVERLAP,
      ...options?.dynamicOverlapConfig,
    };
    this.enableHierarchicalContext = options?.enableHierarchicalContext ?? true;
    this.enableCrossReferences = options?.enableCrossReferences ?? true;
  }

  chunk(content: string, config: ChunkingConfig): MemoryChunk[] {
    // First, use semantic chunking to get base chunks
    const baseChunks = semanticChunker.chunk(content, config);

    // Then enhance with metadata
    const lines = content.split("\n");
    const codeBlocks = findCodeBlocks(lines);

    const enhancedChunks: EnhancedMemoryChunk[] = [];

    for (let i = 0; i < baseChunks.length; i += 1) {
      const chunk = baseChunks[i]!;
      const chunkLines = lines.slice(chunk.startLine - 1, chunk.endLine);
      const startIndex = chunk.startLine - 1;

      // Analyze content type
      const contentType = analyzeContentType(chunkLines);

      // Extract section heading
      const { heading: sectionHeading, level: sectionLevel } = extractSectionHeading(
        lines,
        startIndex,
      );

      // Check for code
      const hasCode = this.chunkHasCode(chunk.startLine - 1, chunk.endLine - 1, codeBlocks);

      // Calculate dynamic overlap for this chunk
      const dynamicOverlap = calculateDynamicOverlap(contentType, hasCode, this.dynamicOverlapConfig);

      // Build neighbors
      const neighbors: EnhancedMemoryChunk["metadata"]["neighbors"] = {};

      if (this.enableCrossReferences) {
        if (i > 0) {
          neighbors.previousChunkId = this.buildChunkId(baseChunks[i - 1]!);
        }
        if (i < baseChunks.length - 1) {
          neighbors.nextChunkId = this.buildChunkId(baseChunks[i + 1]!);
        }
        // Find parent section (chunk containing the section heading)
        if (sectionHeading) {
          neighbors.parentChunkId = this.findParentChunkId(
            baseChunks,
            lines,
            startIndex,
            sectionLevel,
          );
        }
      }

      const enhanced: EnhancedMemoryChunk = {
        ...chunk,
        chunkId: this.buildChunkId(chunk),
        metadata: {
          sectionHeading,
          sectionLevel,
          hasCode,
          contentType,
          neighbors,
        },
      };

      enhancedChunks.push(enhanced);
    }

    // For now, return base MemoryChunk format for compatibility
    // In a future update, we could extend the type to include metadata
    return enhancedChunks;
  }

  /**
   * Get enhanced chunks with full metadata.
   */
  chunkEnhanced(content: string, config: ChunkingConfig): EnhancedMemoryChunk[] {
    const result = this.chunk(content, config);
    return result as EnhancedMemoryChunk[];
  }

  /**
   * Check if a chunk range contains any code blocks.
   */
  private chunkHasCode(
    startLine: number,
    endLine: number,
    codeBlocks: Array<{ start: number; end: number }>,
  ): boolean {
    for (const block of codeBlocks) {
      // Check for overlap between chunk range and code block
      if (startLine <= block.end && endLine >= block.start) {
        return true;
      }
    }
    return false;
  }

  /**
   * Build a unique chunk ID.
   */
  private buildChunkId(chunk: MemoryChunk): string {
    return hashText(`${chunk.startLine}:${chunk.endLine}:${chunk.hash}`);
  }

  /**
   * Find the parent chunk that contains the section heading.
   */
  private findParentChunkId(
    chunks: MemoryChunk[],
    lines: string[],
    startIndex: number,
    sectionLevel: number,
  ): string | undefined {
    // Search backward for a chunk that contains a higher-level heading
    for (let i = startIndex - 1; i >= 0; i -= 1) {
      const line = lines[i] ?? "";
      const level = getHeadingLevel(line);
      if (level > 0 && level < sectionLevel) {
        // Find which chunk contains this line
        for (const chunk of chunks) {
          if (i >= chunk.startLine - 1 && i < chunk.endLine) {
            return this.buildChunkId(chunk);
          }
        }
        break;
      }
    }
    return undefined;
  }
}

/**
 * Singleton instance for convenience.
 */
export const advancedChunker = new AdvancedChunker();

/**
 * Chunk markdown content using the advanced strategy.
 *
 * @param content - The markdown content to chunk
 * @param config - Chunking configuration
 * @param options - Advanced chunking options
 * @returns Array of enhanced memory chunks
 */
export function chunkMarkdownAdvanced(
  content: string,
  config: ChunkingConfig,
  options?: {
    dynamicOverlapConfig?: Partial<DynamicOverlapConfig>;
    enableHierarchicalContext?: boolean;
    enableCrossReferences?: boolean;
  },
): EnhancedMemoryChunk[] {
  const chunker = new AdvancedChunker(options);
  return chunker.chunkEnhanced(content, config);
}

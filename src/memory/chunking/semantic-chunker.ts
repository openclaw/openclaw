/**
 * Semantic chunking strategy for memory segmentation.
 *
 * This chunker is structure-aware and will:
 * 1. Detect and preserve markdown structure (headings, code blocks, lists)
 * 2. Prefer splitting at semantic boundaries (paragraph breaks, sentences)
 * 3. Avoid breaking code blocks, keeping them intact
 * 4. Group related content under the same heading
 */

import { estimateUtf8Bytes } from "../embedding-input-limits.js";
import { hashText, type MemoryChunk } from "../internal.js";
import type { ChunkStrategy, ChunkingConfig } from "./chunk-strategy.js";
import {
  findSplitPoints,
  findCodeBlocks,
  isInsideCodeBlock,
  splitLongLineByBytes,
  wouldBreakStructure,
} from "./markdown-boundaries.js";
import { buildTextEmbeddingInput } from "../embedding-inputs.js";

/**
 * Semantic chunker implementation.
 */
export class SemanticChunker implements ChunkStrategy {
  readonly name = "semantic";

  chunk(content: string, config: ChunkingConfig): MemoryChunk[] {
    const lines = content.split("\n");
    if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
      return [];
    }

    // Analyze document structure
    const codeBlocks = findCodeBlocks(lines);
    const splitPoints = findSplitPoints(lines);

    // Pre-compute byte sizes for all lines
    const lineBytes = lines.map((line) => estimateUtf8Bytes(line) + 1); // +1 for newline

    // Find optimal chunk boundaries using semantic priorities
    const boundaries = this.findOptimalBoundaries(
      lines,
      lineBytes,
      splitPoints,
      codeBlocks,
      config.maxBytes,
    );

    // Create chunks from boundaries
    return this.createChunksFromBoundaries(lines, lineBytes, boundaries, config);
  }

  /**
   * Find optimal chunk boundaries considering semantic structure.
   */
  private findOptimalBoundaries(
    lines: string[],
    lineBytes: number[],
    splitPoints: Array<{ lineIndex: number; priority: number; reason: string }>,
    codeBlocks: Array<{ start: number; end: number }>,
    maxBytes: number,
  ): number[] {
    const boundaries: number[] = [0]; // Always start at line 0
    let currentBytes = 0;
    let lastBoundary = 0;

    // Build a map of line index to split priority for quick lookup
    const priorityMap = new Map<number, number>();
    for (const sp of splitPoints) {
      // Only consider splits after the current position
      if (sp.lineIndex > lastBoundary) {
        const existing = priorityMap.get(sp.lineIndex) ?? Infinity;
        if (sp.priority < existing) {
          priorityMap.set(sp.lineIndex, sp.priority);
        }
      }
    }

    for (let i = 0; i < lines.length; i += 1) {
      const bytes = lineBytes[i] ?? 0;
      currentBytes += bytes;

      // Check if we've exceeded max bytes
      if (currentBytes > maxBytes && i > lastBoundary + 1) {
        // Find the best split point between lastBoundary and i
        const bestSplit = this.findBestSplitPoint(
          lastBoundary,
          i,
          currentBytes,
          maxBytes,
          priorityMap,
          codeBlocks,
          lineBytes,
          lines,
        );

        if (bestSplit > lastBoundary) {
          boundaries.push(bestSplit);
          // Use i + 1 to include the current line in the new chunk's byte count
          currentBytes = this.calculateBytesFrom(bestSplit, i + 1, lineBytes);
          lastBoundary = bestSplit;
        }
      }
    }

    // Add final boundary
    if (lastBoundary < lines.length) {
      boundaries.push(lines.length);
    }

    return boundaries;
  }

  /**
   * Find the best split point in a range, prioritizing semantic boundaries.
   */
  private findBestSplitPoint(
    start: number,
    end: number,
    _currentBytes: number,
    maxBytes: number,
    priorityMap: Map<number, number>,
    codeBlocks: Array<{ start: number; end: number }>,
    lineBytes: number[],
    lines: string[],
  ): number {
    let bestSplit = end;
    let bestPriority = Infinity;

    // Search for a split point that minimizes both priority deviation and size overflow
    for (let i = end; i > start + 1; i -= 1) {
      // Skip if this would break structure (including code blocks, orphaned headings, etc.)
      if (wouldBreakStructure(i, lines, codeBlocks)) {
        continue;
      }

      const priority = priorityMap.get(i) ?? Infinity;

      // Calculate how much we'd be under the limit if we split here
      // Include line i in the left chunk (split happens after line i)
      const bytesAtSplit = this.calculateBytesFrom(start, i, lineBytes);

      // Prefer splits that:
      // 1. Have lower priority (better semantic boundary)
      // 2. Are closer to maxBytes (better space utilization)
      const bytesUnder = maxBytes - bytesAtSplit;
      const isGoodFit = bytesUnder >= 0 && bytesUnder < maxBytes * 0.3; // Within 30% of target

      if (priority < bestPriority || (isGoodFit && priority <= bestPriority)) {
        bestSplit = i;
        bestPriority = priority;

        // Perfect match found
        if (priority <= 2 && bytesUnder >= 0) {
          break;
        }
      }

      // Don't go too far back
      if (bytesAtSplit < maxBytes * 0.5) {
        break;
      }
    }

    // Prevent fallback splits from landing inside code blocks
    // When all candidates are skipped, bestSplit may be `end` which could be inside a code block
    if (isInsideCodeBlock(bestSplit, codeBlocks)) {
      // Find the code block that contains bestSplit
      for (const block of codeBlocks) {
        if (bestSplit > block.start && bestSplit < block.end) {
          // Split before the code block starts
          bestSplit = block.start;
          break;
        }
      }
      // Fallback: if still in code block, use start + 1
      if (isInsideCodeBlock(bestSplit, codeBlocks)) {
        bestSplit = start + 1;
      }
    }

    return bestSplit;
  }

  /**
   * Calculate total bytes from start line (inclusive) to end line (exclusive).
   */
  private calculateBytesFrom(
    start: number,
    end: number,
    lineBytes: number[],
  ): number {
    let total = 0;
    for (let i = start; i < end && i < lineBytes.length; i += 1) {
      total += lineBytes[i] ?? 0;
    }
    return total;
  }

  /**
   * Create MemoryChunk objects from boundary indices.
   */
  private createChunksFromBoundaries(
    lines: string[],
    lineBytes: number[],
    boundaries: number[],
    config: ChunkingConfig,
  ): MemoryChunk[] {
    const chunks: MemoryChunk[] = [];

    for (let i = 0; i < boundaries.length - 1; i += 1) {
      let start = boundaries[i] ?? 0;
      const end = boundaries[i + 1] ?? lines.length;

      if (start >= end) {
        continue;
      }

      // Apply overlap: extend start backward using previous chunk's end lines
      if (i > 0 && config.overlapBytes > 0) {
        const prevEnd = boundaries[i - 1] ?? 0;
        const overlapStart = this.findOverlapStart(prevEnd, start, end, lineBytes, config.overlapBytes);
        if (overlapStart < start) {
          start = overlapStart;
        }
      }

      const chunkLines = lines.slice(start, end);
      const text = chunkLines.join("\n");

      // Skip empty chunks
      if (text.trim().length === 0) {
        continue;
      }

      // Handle chunks that are still too large (e.g., long code blocks)
      const chunkSize = this.calculateBytesFrom(start, end, lineBytes);
      if (chunkSize > config.maxBytes * 1.5) {
        // Force split this chunk
        const subChunks = this.forceSplitChunk(chunkLines, config.maxBytes, start);
        chunks.push(...subChunks);
      } else {
        chunks.push({
          startLine: start + 1, // 1-indexed
          endLine: end, // 1-indexed, end is exclusive in boundaries
          text,
          hash: hashText(text),
          embeddingInput: buildTextEmbeddingInput(text),
        });
      }
    }

    return chunks;
  }

  /**
   * Find the start line for overlap content.
   * Searches backward from original start to find how many lines to include for overlap.
   * Always includes at least one line if overlapBytes > 0.
   */
  private findOverlapStart(
    prevEnd: number,
    originalStart: number,
    _end: number,
    lineBytes: number[],
    overlapBytes: number,
  ): number {
    let acc = 0;
    // Search backward from the line before original start, stopping at prevEnd
    for (let i = originalStart - 1; i > prevEnd; i--) {
      const lineByte = lineBytes[i] ?? 0;
      // Keep at least one line, but don't exceed overlapBytes if we already have some
      if (acc + lineByte > overlapBytes && i < originalStart - 1) {
        return i + 1;
      }
      acc += lineByte;
    }
    return prevEnd;
  }

  /**
   * Force split a chunk that's too large, even if it breaks structure.
   * This is a fallback for things like very long code blocks.
   */
  private forceSplitChunk(lines: string[], maxBytes: number, baseLineNo: number): MemoryChunk[] {
    const chunks: MemoryChunk[] = [];
    let current: string[] = [];
    let currentBytes = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const lineBytes = estimateUtf8Bytes(line) + 1;

      if (currentBytes + lineBytes > maxBytes && current.length > 0) {
        // Flush current chunk
        const text = current.join("\n");
        chunks.push({
          startLine: baseLineNo + 1,
          endLine: baseLineNo + current.length,
          text,
          hash: hashText(text),
          embeddingInput: buildTextEmbeddingInput(text),
        });
        baseLineNo += current.length;
        current = [];
        currentBytes = 0;
      }

      // Check if a single line is too long
      if (lineBytes > maxBytes) {
        // Split the long line using byte-aware splitting
        const segments = splitLongLineByBytes(line, maxBytes - 1);
        for (const segment of segments) {
          chunks.push({
            startLine: baseLineNo + 1,
            endLine: baseLineNo + 1,
            text: segment,
            hash: hashText(segment),
            embeddingInput: buildTextEmbeddingInput(segment),
          });
        }
        baseLineNo += 1;
      } else {
        current.push(line);
        currentBytes += lineBytes;
      }
    }

    // Flush remaining
    if (current.length > 0) {
      const text = current.join("\n");
      chunks.push({
        startLine: baseLineNo + 1,
        endLine: baseLineNo + current.length,
        text,
        hash: hashText(text),
        embeddingInput: buildTextEmbeddingInput(text),
      });
    }

    return chunks;
  }
}

/**
 * Singleton instance for convenience.
 */
export const semanticChunker = new SemanticChunker();

/**
 * Chunk markdown content using the semantic strategy.
 *
 * This strategy is structure-aware and will:
 * - Detect and preserve markdown structure
 * - Prefer splitting at semantic boundaries
 * - Avoid breaking code blocks when possible
 *
 * @param content - The markdown content to chunk
 * @param config - Chunking configuration
 * @returns Array of memory chunks
 */
export function chunkMarkdownSemantic(
  content: string,
  config: ChunkingConfig,
): MemoryChunk[] {
  return semanticChunker.chunk(content, config);
}

import { chunkTextByBreakResolver } from "../shared/text-chunking.js";

/**
 * Chunk text for outbound messages, respecting markdown code block boundaries.
 * 
 * When a split point falls inside a code block (```), it will try to break
 * at the end of the code block instead of splitting the block mid-way.
 */
export function chunkTextForOutbound(text: string, limit: number): string[] {
  return chunkTextByBreakResolver(text, limit, (window, windowStart) => {
    // Determine if we're inside a code block at windowStart position
    let inCodeBlock = false;
    const prefix = text.slice(0, windowStart);
    const blockMarkerRegex = /```/g;
    let match;
    while ((match = blockMarkerRegex.exec(prefix)) !== null) {
      inCodeBlock = !inCodeBlock;
    }
    
    // If inside a code block, find the closing ``` and break after it
    if (inCodeBlock) {
      const closingPos = text.indexOf("```", windowStart);
      if (closingPos !== -1) {
        const blockEnd = closingPos + 3 - windowStart;
        // Only use this break point if it's within the window
        if (blockEnd <= window.length) {
          return blockEnd;
        }
      }
      // No closing marker within reach, fall back to newline
      const lastNewline = window.lastIndexOf("\n");
      if (lastNewline > 0) {
        return lastNewline;
      }
      // No newline, must split mid-block (unavoidable)
      return window.length;
    }
    
    // Not in a code block - check if a code block starts within window
    const blockStartInWindow = window.indexOf("```");
    if (blockStartInWindow > 0) {
      // Break before the code block to keep it intact in next chunk
      // But only if there's meaningful content before it
      const beforeBlock = window.slice(0, blockStartInWindow).trim();
      if (beforeBlock.length > 0) {
        // Prefer breaking at newline before the block
        const lastNewlineBefore = window.slice(0, blockStartInWindow).lastIndexOf("\n");
        if (lastNewlineBefore > 0) {
          return lastNewlineBefore;
        }
        // Or at space
        const lastSpaceBefore = window.slice(0, blockStartInWindow).lastIndexOf(" ");
        if (lastSpaceBefore > 0) {
          return lastSpaceBefore;
        }
      }
    }
    
    // Default: prefer newline over space
    const lastNewline = window.lastIndexOf("\n");
    const lastSpace = window.lastIndexOf(" ");
    return lastNewline > 0 ? lastNewline : lastSpace;
  });
}
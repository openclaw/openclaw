import { chunkTextByBreakResolver } from "../shared/text-chunking.js";

/**
 * Chunk text for outbound messages, respecting markdown code block boundaries.
 *
 * When a split point falls inside a code block (```), it will try to break
 * at the end of the code block instead of splitting the block mid-way.
 */
export function chunkTextForOutbound(text: string, limit: number): string[] {
  // Pre-compute all code block marker positions (O(n) once, not O(n²))
  const markers: number[] = [];
  const blockMarkerRegex = /```/g;
  let match;
  while ((match = blockMarkerRegex.exec(text)) !== null) {
    markers.push(match.index);
  }

  return chunkTextByBreakResolver(text, limit, (window, windowStart) => {
    // Determine if we're inside a code block at windowStart position
    // Count markers before windowStart
    const countBefore = markers.filter((pos) => pos < windowStart).length;
    const inCodeBlock = countBefore % 2 === 1;

    // If inside a code block, find the closing ``` and break after it
    if (inCodeBlock) {
      // Find the next marker after windowStart
      const closingMarkerIdx = markers.findIndex((pos) => pos >= windowStart);
      if (closingMarkerIdx !== -1) {
        const closingPos = markers[closingMarkerIdx];
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
    // Find the first marker >= windowStart
    const firstMarkerInWindowIdx = markers.findIndex((pos) => pos >= windowStart);
    if (firstMarkerInWindowIdx !== -1) {
      const firstMarkerPos = markers[firstMarkerInWindowIdx];
      const blockStartInWindow = firstMarkerPos - windowStart;

      if (blockStartInWindow >= 0 && blockStartInWindow < window.length) {
        // If the block starts at position 0, try to fit the entire block
        if (blockStartInWindow === 0) {
          // Find the closing marker for this block
          if (firstMarkerInWindowIdx + 1 < markers.length) {
            const closingPos = markers[firstMarkerInWindowIdx + 1];
            const blockEnd = closingPos + 3 - windowStart;
            if (blockEnd <= window.length) {
              return blockEnd;
            }
          }
          // No closing marker found, fall through to default
        } else {
          // Block starts after position 0 - break before it
          const beforeBlock = window.slice(0, blockStartInWindow).trim();
          if (beforeBlock.length > 0) {
            // Prefer breaking at newline before the block
            const lastNewlineBefore = window
              .slice(0, blockStartInWindow)
              .lastIndexOf("\n");
            if (lastNewlineBefore > 0) {
              return lastNewlineBefore;
            }
            // Or at space
            const lastSpaceBefore = window
              .slice(0, blockStartInWindow)
              .lastIndexOf(" ");
            if (lastSpaceBefore > 0) {
              return lastSpaceBefore;
            }
          }
        }
      }
    }

    // Default: prefer newline over space
    const lastNewline = window.lastIndexOf("\n");
    const lastSpace = window.lastIndexOf(" ");
    return lastNewline > 0 ? lastNewline : lastSpace;
  });
}
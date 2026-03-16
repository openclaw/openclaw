import { chunkTextByBreakResolver } from "../shared/text-chunking.js";

interface FenceMarker {
  pos: number;
  len: number;
}

/**
 * Chunk text for outbound messages, respecting markdown code block boundaries.
 *
 * When a split point falls inside a code block (```), it will try to break
 * at the end of the code block instead of splitting the block mid-way.
 */
export function chunkTextForOutbound(text: string, limit: number): string[] {
  // Pre-compute all fenced code block marker positions (O(n) once, not O(n²))
  // Only count ``` that start on their own line (fenced code blocks)
  // This avoids treating inline ``` as block markers
  // Also handles 4+ backtick fences correctly
  const markers: FenceMarker[] = [];
  const fenceRegex = /(?:^|\n)(```+)/g;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    // Record the position of the actual backticks (after optional newline)
    const markerStart = match.index + (match[0].length - match[1].length);
    markers.push({ pos: markerStart, len: match[1].length });
  }

  return chunkTextByBreakResolver(text, limit, (window, windowStart = 0) => {
    // Determine if we're inside a code block at windowStart position
    // Count markers before windowStart
    const countBefore = markers.filter((m) => m.pos < windowStart).length;
    const inCodeBlock = countBefore % 2 === 1;

    // If inside a code block, find the closing fence and break after it
    if (inCodeBlock) {
      // Find the next marker after windowStart
      const closingMarker = markers.find((m) => m.pos >= windowStart);
      if (closingMarker) {
        const blockEnd = closingMarker.pos + closingMarker.len - windowStart;
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
    const firstMarkerIdx = markers.findIndex((m) => m.pos >= windowStart);
    if (firstMarkerIdx !== -1) {
      const firstMarker = markers[firstMarkerIdx];
      const blockStartInWindow = firstMarker.pos - windowStart;

      if (blockStartInWindow >= 0 && blockStartInWindow < window.length) {
        // If the block starts at position 0, try to fit the entire block
        if (blockStartInWindow === 0) {
          // Find the closing marker for this block (must have same length)
          for (let i = firstMarkerIdx + 1; i < markers.length; i++) {
            const candidate = markers[i];
            if (candidate.len === firstMarker.len) {
              const blockEnd = candidate.pos + candidate.len - windowStart;
              if (blockEnd <= window.length) {
                return blockEnd;
              }
              break; // Found matching closer, even if doesn't fit
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

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export async function sanitizeToolResultMedia(
  result: AgentToolResult<unknown>,
  _label: string,
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];
  
  // Check if this is audio or video content (runtime check, bypass type errors)
  const hasMedia = content.some(block => {
    if (!block || typeof block !== 'object') {
      return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blockType = (block as any).type;
    return blockType === 'audio' || blockType === 'video';
  });
  
  if (hasMedia) {
    // Return untouched - don't sanitize audio/video
    return result;
  }
  
  // For non-media, pass through
  return result;
}
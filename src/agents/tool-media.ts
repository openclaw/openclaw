import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export async function sanitizeToolResultMedia(
  result: AgentToolResult<unknown>,
  _label: string,
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];
  
  // Check if this is audio or video content
  // @ts-ignore - types don't include audio/video but runtime might
  const hasMedia = content.some(block => 
    block && typeof block === 'object' && 
    'type' in block && (block.type === 'audio' || block.type === 'video')
  );
  
  if (hasMedia) {
    // Return untouched - don't sanitize audio/video
    return result;
  }
  
  // For non-media, pass through
  return result;
}
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export async function sanitizeToolResultMedia(
  result: AgentToolResult<unknown>,
  label: string,
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];
  
  // Check if this is audio or video content
  const hasMedia = content.some(block => 
    block && typeof block === 'object' && 
    ((block as any).type === 'audio' || (block as any).type === 'video')
  );
  
  if (hasMedia) {
    // Return untouched - don't sanitize audio/video
    return result;
  }
  
  // For non-media, pass through
  return result;
}
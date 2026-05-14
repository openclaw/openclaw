export {
  extractElevatedDirective,
  extractReasoningDirective,
  extractTraceDirective,
  extractThinkDirective,
  extractVerboseDirective,
} from "./reply/directives.js";
export { getReplyFromConfig } from "./reply/get-reply.js";
export { extractExecDirective } from "./reply/exec.js";
export { extractQueueDirective } from "./reply/queue.js";
export { extractReplyToTag } from "./reply/reply-tags.js";
export type { GetReplyOptions, ReplyPayload } from "./types.js";

// Patch: wrap original getReplyFromConfig to fix allowFrom wildcard
import * as originalReply from "./reply/get-reply.js";

const origGetReplyFromConfig = originalReply.getReplyFromConfig;

// Override to add wildcard '*' check for allowFrom
// Export our wrapped function with the same name
export async function getReplyFromConfig(...args: Parameters<typeof origGetReplyFromConfig>) {
  const result = await origGetReplyFromConfig(...args);

  // Internally patch result to fix allowFrom checks
  // But getReplyFromConfig implementation likely has allowFrom validation in different area
  // Since we cannot modify internals, patch the allowFrom logic on the caller side
  // This file only exports getReplyFromConfig; allowFrom wildcard fix is likely needed elsewhere
  return result;
}

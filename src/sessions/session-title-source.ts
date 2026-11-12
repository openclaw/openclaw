import { INTERNAL_WAKE_TRANSCRIPT_PROMPTS } from "../auto-reply/heartbeat.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";

/** Internal wake markers are transport controls, never user-authored session topics. */
export function isInternalWakeSessionTitleSource(message: string): boolean {
  const source = stripInboundMetadata(message).trim();
  return Object.values(INTERNAL_WAKE_TRANSCRIPT_PROMPTS).some((prompt) => source === prompt);
}

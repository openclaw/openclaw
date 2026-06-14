// System event queue helpers without the broad infra-runtime barrel.

import { enqueueSystemEvent as enqueueSystemEventInternal } from "../infra/system-events.js";

export {
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";

/**
 * SDK consumers are untrusted by construction — force `trusted: false` so a
 * plugin cannot set `trusted: true` to bypass the inbound anti-spoof sanitizer.
 * Trusted-internal producers use the direct `infra/system-events` import.
 */
export function enqueueSystemEvent(
  text: string,
  options: Parameters<typeof enqueueSystemEventInternal>[1],
): boolean {
  return enqueueSystemEventInternal(text, { ...options, trusted: false });
}

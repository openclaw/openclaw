// Cancels captured mailbox sources without releasing live source custody.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  clearSessionControllerMailbox,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import { getExistingFollowupQueue } from "./state.js";

export function clearSessionQueues(
  keys: Array<string | undefined>,
  target?: SessionTarget,
  capturedInputs?: readonly SessionControllerInput[],
  assertCurrent?: () => void,
): string[] {
  const seen = new Set<string>();
  const clearedQueues = new Set<NonNullable<ReturnType<typeof getExistingFollowupQueue>>>();
  const clearedKeys: string[] = [];
  for (const key of keys) {
    const cleaned = normalizeOptionalString(key);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    clearedKeys.push(cleaned);
    assertCurrent?.();
    const queue = getExistingFollowupQueue(cleaned, target);
    if (queue && !clearedQueues.has(queue)) {
      clearedQueues.add(queue);
      clearSessionControllerMailbox(
        queue,
        completeFollowupRunLifecycle,
        capturedInputs,
        assertCurrent,
      );
    }
  }
  return clearedKeys;
}

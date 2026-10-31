import { sessionControllerMailboxes } from "../../../sessions/session-controller.mailbox.js";

/** Clear the process-global redelivery cache between tests, including fresh module instances. */
export function resetRecentQueuedMessageIdDedupe(): void {
  for (const mailbox of sessionControllerMailboxes()) {
    mailbox.recentSources.clear();
  }
}

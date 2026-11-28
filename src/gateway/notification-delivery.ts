import {
  humanMentionNotificationIntent,
  resolveEventNotificationIntent,
  type HumanMentionNotification,
  type NotificationIntent,
} from "./notification-intent.js";
// Fans transport-neutral notification intents out to their destinations.
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";

/**
 * A transport that delivers notification intents to people, such as Web Push.
 *
 * `deliver` starts delivery and returns; the destination owns its asynchronous work,
 * logging and failures and must not throw. For every recipient it reaches, a destination:
 * - resolves the recipient's current authority with `intent.requiredScopes` (plus any
 *   `intent.visibilityScopes` the recipient currently holds) and skips recipients without it;
 * - holds facts from `withNotificationSessionFacts`, awaits its `publication` with
 *   `intent.recipient?.prepare`, then calls `canNotificationRecipientReceive` synchronously
 *   before sending;
 * - sends a targeted intent only to `currentNotificationRecipientProfileId`, and only while
 *   `intent.recipient.isCurrent()` holds, checked with no awaited work before the send;
 * - applies the recipient's notification preferences and renders copy with
 *   `renderNotificationCopy`.
 */
export type NotificationDestination = {
  deliver: (intent: NotificationIntent) => void;
};

/** Produces each notification once and hands the same intent to every destination. */
export function createNotificationDelivery(destinations: readonly NotificationDestination[]) {
  const deliver = (intent: NotificationIntent) => {
    for (const destination of destinations) {
      destination.deliver(intent);
    }
  };
  return {
    handleEvent(event: string, payload: unknown, opts?: GatewayBroadcastOpts): void {
      const intent = resolveEventNotificationIntent(event, payload, opts);
      if (intent) {
        deliver(intent);
      }
    },
    deliverMention(this: void, mention: HumanMentionNotification): void {
      deliver(humanMentionNotificationIntent(mention));
    },
  };
}

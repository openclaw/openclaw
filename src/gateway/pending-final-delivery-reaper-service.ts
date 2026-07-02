/**
 * Gateway-side host for the pending-final-delivery reaper (#93625).
 *
 * Wires the pure reaper pass (`infra/pending-final-delivery-reaper.ts`) to real
 * runtime deps and a periodic timer. `activateGatewayScheduledServices` starts
 * it once at startup (not re-run on reload), so the interval is `unref`'d and
 * carries no stop handle.
 *
 * Delivery goes through `sendDurableMessageBatch` (the durable message-send
 * substrate). The owning run already produced the text, so the reaper sends it
 * as-is and never re-runs the agent.
 */
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent-runner/runs.js";
import { sendDurableMessageBatch } from "../channels/message/send.js";
import { listSessionEntries, updateSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type MessageChannelId, resolveKnownChannel } from "../infra/outbound/channel-selection.js";
import {
  type StrandedReply,
  pendingFinalDeliverySnapshotMatches,
  reapStrandedPendingFinalDeliveries,
} from "../infra/pending-final-delivery-reaper.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const DEFAULT_REAP_INTERVAL_MS = 60_000;
const log = createSubsystemLogger("pending-final-delivery-reaper");

/** Clears every `pendingFinalDelivery*` field once the reply has been delivered. */
const CLEARED_PENDING_FINAL_DELIVERY = {
  pendingFinalDelivery: undefined,
  pendingFinalDeliveryText: undefined,
  pendingFinalDeliveryCreatedAt: undefined,
  pendingFinalDeliveryLastAttemptAt: undefined,
  pendingFinalDeliveryAttemptCount: undefined,
  pendingFinalDeliveryLastError: undefined,
  pendingFinalDeliveryContext: undefined,
  pendingFinalDeliveryIntentId: undefined,
} as const;

function resolveReplyRoute(
  reply: StrandedReply,
): { channel: Exclude<MessageChannelId, "none">; to: string } | null {
  const { entry } = reply;
  const ctx = entry.pendingFinalDeliveryContext;
  const rawChannel = ctx?.channel ?? entry.route?.channel ?? entry.lastChannel;
  const to = ctx?.to ?? entry.route?.target?.to ?? entry.lastTo;
  const channel = resolveKnownChannel(rawChannel);
  if (!channel || channel === "none" || !to) {
    return null;
  }
  return { channel, to };
}

/**
 * Start the reaper loop. The interval is `unref`'d and runs for the process
 * lifetime — `activateGatewayScheduledServices` starts it once at startup and
 * is not re-run on reload, so no stop handle is threaded.
 */
export function startPendingFinalDeliveryReaper(params: {
  cfg: OpenClawConfig;
  intervalMs?: number;
}): void {
  const intervalMs = params.intervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  let running = false;

  const runPass = async (): Promise<void> => {
    if (running) {
      return; // never overlap passes; a slow channel must not stack reaper work
    }
    running = true;
    try {
      await reapStrandedPendingFinalDeliveries({
        listEntries: () => listSessionEntries({ clone: true }),
        isRunActive: (sessionId) => isEmbeddedAgentRunActive(sessionId),
        now: () => Date.now(),
        log,
        deliver: async (reply) => {
          const route = resolveReplyRoute(reply);
          const text = reply.entry.pendingFinalDeliveryText;
          if (!route || !text) {
            return false;
          }
          const ctx = reply.entry.pendingFinalDeliveryContext;
          const accountId = ctx?.accountId ?? reply.entry.route?.accountId;
          const threadId = ctx?.threadId;
          const result = await sendDurableMessageBatch({
            cfg: params.cfg,
            channel: route.channel,
            to: route.to,
            ...(accountId ? { accountId } : {}),
            ...(threadId != null ? { threadId } : {}),
            payloads: [{ text }],
            bestEffort: true,
          });
          // Treat anything but a clean send/suppression as a failed attempt so
          // the reaper records it and retries up to the cap (never clears).
          if (result.status !== "sent" && result.status !== "suppressed") {
            throw new Error(`pending-final-delivery send ${result.status}`);
          }
          return true;
        },
        clearPending: async (reply) => {
          // Clear only if the current entry still holds the snapshot we delivered;
          // a same-session run may have written a newer pendingFinalDelivery while
          // the send was in flight, and clearing by key would erase it (#94150 review).
          await updateSessionEntry({ sessionKey: reply.sessionKey }, (current) =>
            pendingFinalDeliverySnapshotMatches(current, reply.entry)
              ? { ...CLEARED_PENDING_FINAL_DELIVERY }
              : null,
          );
        },
        recordFailedAttempt: async (reply, error) => {
          await updateSessionEntry({ sessionKey: reply.sessionKey }, (entry) => ({
            pendingFinalDeliveryLastAttemptAt: Date.now(),
            pendingFinalDeliveryAttemptCount: (entry.pendingFinalDeliveryAttemptCount ?? 0) + 1,
            pendingFinalDeliveryLastError: error,
          }));
        },
      });
    } catch (err) {
      log.warn(
        `pending-final-delivery reaper pass failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      running = false;
    }
  };

  // unref so a pending reaper tick never keeps the process alive on shutdown.
  setInterval(() => void runPass(), intervalMs).unref?.();
}

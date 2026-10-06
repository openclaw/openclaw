// Outbound delivery queue contracts shared by storage and failure lifecycle owners.
import type { CommandOwnerAssertion } from "../../auto-reply/command-owner-authority.js";
import type { SessionWriterDeliveryAuthority } from "../../auto-reply/reply-payload.js";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type {
  ChannelMessageUnknownSendReconciliationResult,
  OutboundReplyFacts,
  RenderedMessageBatchPlan,
} from "../../channels/message/types.js";
import type { SessionDeliveryGeneration } from "../../config/sessions/session-delivery-generation.types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { PluginHookReplyPayloadSendingContext } from "../../plugins/hook-types.js";
import type {
  DeliveryQueueCompletionRetention,
  DeliveryQueueEntryState,
} from "../delivery-queue-sqlite.types.js";
import type { IndexedOutboundAuditTerminal } from "./deliver-types.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import type { DeliveryMirror } from "./mirror.js";
import type { PreparedOutboundBatch } from "./prepared-batch.js";
import type { OutboundSessionContext } from "./session-context.js";

/** Serializable owner callback for a durable queue entry. */
export type DurableDeliveryCompletion =
  | {
      kind: "conversation";
      agentId: string;
      operationId: string;
      storePath?: string;
      /** Present on Gateway-owned conversation intents created with route authorization. */
      routeFingerprint?: string;
    }
  | {
      kind: "pending-final";
      /** Null means an owner was admitted without recoverable authority; fail closed. */
      commandOwnerReference?: CommandOwnerAssertion["recoveryReference"];
      /** Older queue records retain the canonical locator's original owner selection. */
      agentId?: string;
      deliveryId: string;
      intentId: string;
      sessionId: string;
      sessionKey: string;
      storePath: string;
      sessionWriterDeliveryAuthority?: SessionWriterDeliveryAuthority;
    };

export function hasActiveDeliveryOwner(entry: DeliveryQueueEntryState, now: number): boolean {
  return (
    (typeof entry.completionRetention === "object" ||
      entry.completionRetention === "permanent" ||
      entry.requiresProducerClaim === true) &&
    (entry.recoveryState === "producer_claimed" ||
      ((entry.recoveryState === "send_attempt_started" ||
        entry.recoveryState === "unknown_after_send") &&
        entry.requiresProducerClaim === true)) &&
    typeof entry.availableAt === "number" &&
    entry.availableAt > now
  );
}

export type QueuedReplyPayloadSendingHook = {
  kind: ReplyDispatchKind;
  channel?: string;
  sessionKey?: string;
  runId?: string;
  context: PluginHookReplyPayloadSendingContext;
};

export type QueuedDeliveryPayload = {
  sessionGeneration?: SessionDeliveryGeneration;
  channel: string;
  to: string;
  accountId?: string;
  queuePolicy?: "required" | "best_effort";
  requireUnknownSendReconciliation?: boolean;
  requiresProducerClaim?: boolean;
  preparedBatch?: PreparedOutboundBatch;
  payloads?: ReplyPayload[];
  renderedBatchPlan?: RenderedMessageBatchPlan;
  threadId?: string | number | null;
  reply?: OutboundReplyFacts;
  formatting?: OutboundDeliveryFormattingOptions;
  identity?: OutboundIdentity;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  mirror?: DeliveryMirror;
  session?: OutboundSessionContext;
  gatewayClientScopes?: readonly string[];
  preparedMessageId?: string;
  deliveryCompletion?: DurableDeliveryCompletion;
  completionRetention?: DeliveryQueueCompletionRetention;
  legacyUnknownSendReconciliation?: Exclude<
    ChannelMessageUnknownSendReconciliationResult,
    { status: "unresolved" }
  >;
  legacyPreparedContentUnavailable?: true;
  maxRetries?: number;
};

export interface LegacyQueuedDelivery extends Omit<
  QueuedDelivery,
  "preparedBatch" | "settlement" | "retainOnFailure" | "recoveryState"
> {
  payloads: ReplyPayload[];
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  replyPayloadSendingHook?: QueuedReplyPayloadSendingHook;
  recoveryState?: Exclude<QueuedDelivery["recoveryState"], "settlement_pending">;
}

export type LegacyQueuedDeliveryPreparation = LegacyQueuedDelivery & {
  legacyPreparationState: "claimed" | "modifiers_started";
  retainOnFailure?: true;
  legacyPreparationOwnerId?: string;
  legacyPreparationLeaseExpiresAt?: number;
};

export type DeliveryFailureSettlement = {
  error: string;
  unknownSendCleanup?: true;
  terminals?: readonly IndexedOutboundAuditTerminal[];
} & ({ outcome: "unknown" } | { outcome: "failed"; rejectionError?: string });

export type QueuedDelivery = Omit<QueuedDeliveryPayload, "preparedBatch" | "payloads"> &
  Omit<DeliveryQueueEntryState, "attemptCount" | "recoveryState" | "acknowledgedAt"> & {
    preparedBatch: PreparedOutboundBatch;
    attemptCount: number;
    effectiveReplyToId?: string | null;
    recoveryState?:
      | "producer_claimed"
      | "send_attempt_started"
      | "unknown_after_send"
      | "settlement_pending";
    settlement?: DeliveryFailureSettlement;
  };

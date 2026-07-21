import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import type { OutboundDeliveryResult, OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
import type { DurableDeliveryCompletion } from "./delivery-completion.js";
import type { OutboundDeliveryPolicySource } from "./delivery-policy-hook.js";
import type {
  QueuedRenderedMessageBatchPlan,
  QueuedReplyPayloadSendingHook,
} from "./delivery-queue-storage.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import type { DeliveryMirror } from "./mirror.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import type { OutboundSendDeps } from "./send-deps.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

/** Internal policy controls accepted by the outbound delivery boundary. */
export type OutboundDeliveryPolicyParams = {
  deliveryPolicy?: {
    path?: "durable_delivery" | "message_action";
    action?: string;
    source?: OutboundDeliveryPolicySource;
    runId?: string;
  };
  skipInitialOutboundDeliveryPolicy?: boolean;
  deliveryPolicyDepth?: number;
};

/** Durability requirement for an outbound delivery intent. */
export type OutboundDeliveryQueuePolicy = "required" | "best_effort";

/** Durable identity recorded before an outbound platform send. */
export type OutboundDeliveryIntent = {
  id: string;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  queuePolicy: OutboundDeliveryQueuePolicy;
};

/** Reply and thread coordinates used for one platform send. */
export type PlatformSendRoute = {
  replyToId?: string | null;
  threadId?: string | number | null;
};

/** Internal parameter contract for durable outbound payload delivery. */
export type DeliverOutboundPayloadsCoreParams = OutboundDeliveryPolicyParams & {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  mediaAccess?: OutboundMediaAccess;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  replyPayloadSendingHook?: QueuedReplyPayloadSendingHook;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
  /** @internal Reports the effective payload only after an identified platform send. */
  onDeliveredPayload?: (payload: NormalizedOutboundPayload) => void;
  onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
  /** @internal Runs after each identified platform result, before further fallible work. */
  onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
  /** @internal Persists ambiguous-send state immediately before platform I/O. */
  onPlatformSendStart?: (route: PlatformSendRoute) => Promise<void>;
  /** @internal Opaque durable intent id forwarded to provider reconciliation hooks. */
  deliveryQueueId?: string;
  /** @internal Stable producer id used to make queue creation idempotent across crashes. */
  deliveryIntentId?: string;
  /** @internal Serializable owner state finalized after live or recovered delivery. */
  deliveryCompletion?: DurableDeliveryCompletion;
  /** @internal Channel-valid id reserved before a correlated conversation turn is sent. */
  preparedMessageId?: string;
  /** @internal Recheck the concrete post-hook send shape before platform I/O. */
  requiredUnknownSendReconciliation?: boolean;
  /** @internal Caller preflight explicitly required provider unknown-send reconciliation. */
  requireUnknownSendReconciliation?: boolean;
  /** @internal Refresh durable timing before recipient-visible or finalizing platform I/O. */
  onPlatformSendDispatch?: () => Promise<void>;
  /** Session/agent context used for hooks and media local-root scoping. */
  session?: OutboundSessionContext;
  mirror?: DeliveryMirror;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
  conversationReadOrigin?: "delegated" | "direct-operator";
};

/** Durable delivery parameters including queue and recovery controls. */
export type DeliverOutboundPayloadsParams = DeliverOutboundPayloadsCoreParams & {
  /** @internal Skip write-ahead queue during crash recovery. */
  skipQueue?: boolean;
  /** @internal Recovery already ran provider admission after its pending-row re-read. */
  deferredDeliveryAdmissionPassed?: true;
  /** @internal State directory that owns the existing recovery queue entry. */
  deliveryQueueStateDir?: string;
  /** @internal Let recovery run commit hooks after it has acked the recovered queue entry. */
  deferCommitHooks?: boolean;
  queuePolicy?: OutboundDeliveryQueuePolicy;
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
  onDeliveryIntent?: (intent: OutboundDeliveryIntent) => void;
};

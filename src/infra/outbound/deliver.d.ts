import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import type { DeliveryMirror } from "./mirror.js";
import { type NormalizedOutboundPayload } from "./payloads.js";
import { type OutboundSendDeps } from "./send-deps.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";
export type { OutboundDeliveryResult } from "./deliver-types.js";
export type { NormalizedOutboundPayload } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";
export { resolveOutboundSendDep, type OutboundSendDeps } from "./send-deps.js";
type DeliverOutboundPayloadsCoreParams = {
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
    abortSignal?: AbortSignal;
    bestEffort?: boolean;
    onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
    onPayload?: (payload: NormalizedOutboundPayload) => void;
    /** Session/agent context used for hooks and media local-root scoping. */
    session?: OutboundSessionContext;
    mirror?: DeliveryMirror;
    silent?: boolean;
    gatewayClientScopes?: readonly string[];
};
export type DeliverOutboundPayloadsParams = DeliverOutboundPayloadsCoreParams & {
    /** @internal Skip write-ahead queue (used by crash-recovery to avoid re-enqueueing). */
    skipQueue?: boolean;
};
export declare function deliverOutboundPayloads(params: DeliverOutboundPayloadsParams): Promise<OutboundDeliveryResult[]>;

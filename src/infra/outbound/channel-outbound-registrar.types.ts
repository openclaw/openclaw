import type { GetReplyFromConfig } from "../../auto-reply/reply/get-reply.types.js";
import type { SessionEchoTarget } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * Pure type home for the channel-outbound registries. It imports only leaf type
 * modules (no mirror-dispatch / channel-admission / pipeline values), so the
 * `ChannelGatewayContext` (and other type consumers) can reference these types
 * without pulling the outbound delivery pipeline into a module cycle. The runtime
 * modules (`mirror-dispatch.ts`, `channel-admission.ts`) re-export these for callers.
 */

/** A target for a channel echo-admission check. */
export type EchoAdmissionTarget = {
  to: string;
  accountId?: string;
  threadId?: string | number;
};

/**
 * Returns false when an echo delivery to this target is currently not allowed.
 * May be async — telegram re-checks DM pairing/allowlist authorization, which is
 * resolved through the ingress resolver.
 */
export type ChannelEchoAdmission = (
  cfg: OpenClawConfig,
  target: EchoAdmissionTarget,
) => boolean | Promise<boolean>;

/** Dispatches a mirrored turn to a resolved echo target via that target's own account runtime. */
export type MirrorDispatcher = (params: {
  cfg: OpenClawConfig;
  target: SessionEchoTarget;
  /** Drives the mirrored turn from the origin run's bus; replaces the model. */
  replyResolver: GetReplyFromConfig;
  sessionKey?: string;
}) => Promise<void> | void;

/**
 * Host-issued registrar bound to one authenticated channel id. The host binds the id
 * for BOTH the owner and channel keys, so a channel plugin can only register/replace/
 * unregister mirror+admission handlers for its OWN channel and cannot spoof another.
 */
export type ChannelOutboundRegistrar = {
  registerMirrorDispatcher: (accountId: string, dispatcher: MirrorDispatcher) => void;
  unregisterMirrorDispatcher: (accountId: string) => void;
  registerEchoAdmission: (accountId: string, admission: ChannelEchoAdmission) => void;
  unregisterEchoAdmission: (accountId: string) => void;
};

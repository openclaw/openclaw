/**
 * Test-only Host ingress fixture for trusted-human fallback authority.
 *
 * Builds one real channel ingress context through the same production path the
 * runtime uses (stable ingress resolution + host inbound-context builder), so
 * tests exercise the canonical opaque ChannelAdmissionEvidence and the live
 * CommandOwnerAuthority bound to that exact context instead of caller-supplied
 * strings. Nothing here weakens production code: the fixture only drives the
 * existing Host functions.
 */
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextParams,
} from "../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import {
  createChannelAdmissionAudit,
  readChannelContextAdmissionEvidence,
  type ChannelAdmissionAudit,
  type ChannelAdmissionEvidence,
} from "../channels/message-access/admission-evidence.js";
import type { IdentifierAuthentication } from "../channels/message-access/identifier-authentication.js";
import type { ChannelIngressHostOwner } from "../channels/message-access/ingress-host-owner.js";
import { createHostChannelIngressRuntime } from "../channels/message-access/runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";

export type TrustedHumanIngressFixture = Readonly<{
  /** The exact context production hands to ingress consumers. */
  context: Record<string, unknown>;
  /** The opaque Host admission evidence bound to the fixture context. */
  evidence: () => ChannelAdmissionEvidence | undefined;
  audit: ChannelAdmissionAudit;
  /** The synthetic Gateway runtime config the ingress authority reads. */
  config: OpenClawConfig;
  /** Retire the Host: authority and ingress reads stop being current. */
  retire: () => void;
  isLive: () => boolean;
}>;

/**
 * Mints a legitimate Host ingress context: a verified stable participant whose
 * identity is a configured command owner, admitted through the real resolution
 * path, carrying both a live command-owner authority and channel admission
 * evidence bound to that exact context.
 */
export async function createTrustedHumanIngressFixture(
  params: {
    channelId?: string;
    accountId?: string;
    senderId?: string;
    ownerAllowFrom?: readonly string[];
    auditEnabled?: boolean;
    identifierAuthentication?: IdentifierAuthentication;
  } = {},
): Promise<TrustedHumanIngressFixture> {
  const channelId = params.channelId ?? "test";
  const accountId = params.accountId ?? "acct:primary";
  const senderId = params.senderId ?? "owner-1";
  const authentication = params.identifierAuthentication ?? "verified";
  const config: OpenClawConfig = {
    commands: { ownerAllowFrom: [...(params.ownerAllowFrom ?? [senderId])] },
  };
  const audit = createChannelAdmissionAudit({ enabled: params.auditEnabled ?? true });
  const gateway = {
    channelAdmissionAudit: audit,
    getRuntimeConfig: () => config,
  } as GatewayRequestContext;
  let live = true;
  const owner: ChannelIngressHostOwner = {
    channelId,
    isLive: () => live,
    resolveGatewayContext: () => gateway,
  };
  const sessionKey = "agent:main:" + channelId + ":dm:dm-1";
  const channelIngress = await createHostChannelIngressRuntime(owner).resolveStable({
    channelId,
    accountId,
    identity: { authentication: "verified" },
    subject: { stableId: senderId, authentication: { stableId: authentication } },
    conversation: { kind: "direct", id: "dm-1" },
    contextBinding: {
      agentId: "main",
      sessionKey,
      messageId: "msg-1",
      inboundEventKind: "user_request",
    },
    dmPolicy: "allowlist",
    allowFrom: [senderId],
    useDefaultPairingStore: false,
  });
  const buildContext = createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  );
  const context = await buildContext({
    channel: channelId,
    accountId,
    messageId: "msg-1",
    from: channelId + ":route:dm-1",
    sender: { id: senderId },
    conversation: { kind: "direct", id: "dm-1" },
    route: { agentId: "main", routeSessionKey: sessionKey },
    reply: { to: channelId + ":route:dm-1" },
    message: { rawBody: "authorize fallback" },
    channelIngress,
  } satisfies BuildChannelInboundEventContextParams);
  const built = context as Record<string, unknown>;
  return {
    context: built,
    evidence: () => readChannelContextAdmissionEvidence(built),
    audit,
    config,
    retire: () => {
      live = false;
    },
    isLive: () => live,
  };
}

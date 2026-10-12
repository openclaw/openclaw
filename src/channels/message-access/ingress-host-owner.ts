import type { PreparedCommandOwnerAuthority } from "../../auto-reply/command-auth.js";
import type { PreparedRequesterProfile } from "../../auto-reply/requester-profile.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import type { UserChannelIdentity } from "../../state/user-profiles.types.js";
import type { ChannelIngressContextBinding } from "./runtime-types.js";

export type ChannelIngressHostOwner = Readonly<{
  channelId: string;
  isLive: () => boolean;
  resolveGatewayContext?: GatewayContextResolver;
}>;

export type ChannelParticipantInput = {
  identity: Extract<SessionParticipantIdentity, { type: "remote" | "observation" }>;
  binding: ChannelIngressContextBinding;
  childSessionPublication?: { audience: "public"; assertCurrent: () => void };
  promptedAt: number;
  owner: ChannelIngressHostOwner;
  gatewayContext: ReturnType<GatewayContextResolver>;
  verifiedPrincipal?: UserChannelIdentity;
  requesterProfile?: PreparedRequesterProfile;
  commandOwnerAuthority?: PreparedCommandOwnerAuthority;
};

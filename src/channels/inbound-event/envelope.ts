import {
  formatAgentEnvelope,
  resolveEnvelopeFormatOptions,
  type EnvelopeFormatOptions,
} from "../../auto-reply/envelope.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { readSessionUpdatedAt } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAgentRoute,
  type ResolvedAgentRoute,
  type RoutePeer,
} from "../../routing/resolve-route.js";

type ChannelInboundEnvelopeRoute = Pick<ResolvedAgentRoute, "agentId" | "sessionKey">;

export type ChannelInboundEnvelopeInput = {
  channel: string;
  from: string;
  body: string;
  timestamp?: number | Date;
  chatType?: string;
  senderLabel?: string;
  previousTimestamp?: number | Date | null;
  envelope?: EnvelopeFormatOptions;
  fromMe?: boolean;
};

export function createChannelInboundEnvelopeBuilder(params: {
  cfg: OpenClawConfig;
  route: ChannelInboundEnvelopeRoute;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  const envelope = resolveEnvelopeFormatOptions(params.cfg);
  return (input: ChannelInboundEnvelopeInput): string => {
    const previousTimestamp =
      input.previousTimestamp === null
        ? undefined
        : (input.previousTimestamp ??
          readSessionUpdatedAt({ storePath, sessionKey: params.route.sessionKey }));
    return formatAgentEnvelope({
      ...input,
      previousTimestamp,
      envelope: input.envelope ?? envelope,
    });
  };
}

export function resolveChannelInboundRouteEnvelope(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  parentPeer?: RoutePeer | null;
  guildId?: string | null;
  teamId?: string | null;
  memberRoleIds?: string[];
}): {
  route: ResolvedAgentRoute;
  buildEnvelope: ReturnType<typeof createChannelInboundEnvelopeBuilder>;
} {
  const route = resolveAgentRoute(params);
  return {
    route,
    buildEnvelope: createChannelInboundEnvelopeBuilder({ cfg: params.cfg, route }),
  };
}

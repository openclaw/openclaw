import {
  formatAgentEnvelope,
  resolveEnvelopeFormatOptions,
  type AgentEnvelopeParams,
} from "../../auto-reply/envelope.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { readSessionUpdatedAt } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAgentRoute,
  type ResolvedAgentRoute,
  type ResolveAgentRouteInput,
} from "../../routing/resolve-route.js";

type ChannelInboundEnvelopeRoute = Pick<ResolvedAgentRoute, "agentId" | "sessionKey">;

export type ChannelInboundEnvelopeInput = Omit<AgentEnvelopeParams, "previousTimestamp"> & {
  previousTimestamp?: AgentEnvelopeParams["previousTimestamp"] | null;
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

export function resolveChannelInboundRouteEnvelope(params: ResolveAgentRouteInput): {
  route: ResolvedAgentRoute;
  buildEnvelope: ReturnType<typeof createChannelInboundEnvelopeBuilder>;
} {
  const route = resolveAgentRoute(params);
  return {
    route,
    buildEnvelope: createChannelInboundEnvelopeBuilder({ cfg: params.cfg, route }),
  };
}

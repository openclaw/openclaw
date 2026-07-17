import { dispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { recordInboundSession } from "../session.js";
import type {
  AssembledChannelTurn,
  ChannelTurnPlan,
  ChannelTurnResolved,
  PreparedChannelTurn,
  PreparedChannelTurnPlan,
} from "./types.js";

function isChannelTurnPlan<TDispatchResult>(
  value: ChannelTurnResolved<TDispatchResult>,
): value is ChannelTurnPlan | PreparedChannelTurnPlan<TDispatchResult> {
  return "route" in value;
}

function resolvePlannedSession(params: {
  cfg: ChannelTurnPlan["cfg"];
  route: ChannelTurnPlan["route"];
}) {
  return {
    routeSessionKey: params.route.sessionKey,
    storePath: resolveStorePath(params.cfg.session?.store, {
      agentId: params.route.agentId,
    }),
    recordInboundSession,
  };
}

export function assembleChannelTurnPlan(plan: ChannelTurnPlan): AssembledChannelTurn {
  const { route, ...turn } = plan;
  return {
    ...turn,
    agentId: route.agentId,
    ...resolvePlannedSession({ cfg: plan.cfg, route }),
    dispatchReplyWithBufferedBlockDispatcher,
  };
}

export function assembleResolvedChannelTurn<TDispatchResult>(
  value: ChannelTurnResolved<TDispatchResult>,
): AssembledChannelTurn | PreparedChannelTurn<TDispatchResult> {
  if (!isChannelTurnPlan(value)) {
    return value;
  }
  if (!("runDispatch" in value)) {
    return assembleChannelTurnPlan(value);
  }
  const { cfg, route, ...turn } = value;
  return { ...turn, ...resolvePlannedSession({ cfg, route }) };
}

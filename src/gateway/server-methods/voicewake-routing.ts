import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../agents/agent-roster.js";
import {
  loadVoiceWakeRoutingConfig,
  resolveVoiceWakeRouteByTrigger,
} from "../../infra/voicewake-routing.js";
import { resolveVoiceWakeSessionTarget } from "../voicewake-session-target.js";
import type { GatewayRequestHandlers } from "./types.js";

export const voicewakeRoutingHandlers: GatewayRequestHandlers = {
  "voicewake.routing.get": async ({ respond }) => {
    respond(true, { config: await loadVoiceWakeRoutingConfig() });
  },
  "voicewake.routing.resolve": async ({ params, respond, context }) => {
    if (typeof params.trigger !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "trigger must be a string"));
      return;
    }
    const cfg = context.getRuntimeConfig();
    const route = resolveVoiceWakeRouteByTrigger({
      trigger: params.trigger,
      config: await loadVoiceWakeRoutingConfig(),
    });
    const target = resolveVoiceWakeSessionTarget({
      route,
      cfg,
      knownAgents: listAgentIds(cfg),
      trigger: params.trigger,
      warn: (message) => context.logGateway.warn(message),
    });
    if (!("mode" in route) && !target) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "voice wake route is unavailable"),
      );
      return;
    }
    respond(true, { sessionKey: target?.sessionKey ?? null });
  },
};

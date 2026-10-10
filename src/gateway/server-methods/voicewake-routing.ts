import { loadVoiceWakeRoutingConfig } from "../../infra/voicewake-routing.js";
import type { GatewayRequestHandlers } from "./types.js";

export const voicewakeRoutingHandlers: GatewayRequestHandlers = {
  "voicewake.routing.get": async ({ respond }) => {
    respond(true, { config: await loadVoiceWakeRoutingConfig() });
  },
};

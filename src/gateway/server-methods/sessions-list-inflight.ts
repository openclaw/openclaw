import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "./types.js";

const sessionListsByContext = new WeakMap<
  GatewayRequestContext,
  { config: OpenClawConfig; inFlight: Map<string, Promise<unknown>> }
>();

export function sessionListInflightMap(
  context: GatewayRequestContext,
  config: OpenClawConfig,
): Map<string, Promise<unknown>> {
  let state = sessionListsByContext.get(context);
  if (!state || state.config !== config) {
    state = { config, inFlight: new Map() };
    sessionListsByContext.set(context, state);
  }
  return state.inFlight;
}

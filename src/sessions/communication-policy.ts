import type {
  EffectiveSessionCommunicationPolicy,
  SessionCommunicationPolicy,
} from "../../packages/gateway-protocol/src/session-communication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type {
  EffectiveSessionCommunicationPolicy,
  SessionCommunicationPolicy,
} from "../../packages/gateway-protocol/src/session-communication.js";

/** Resolve preferences only; existing access and live authority remain separate ceilings. */
export function resolveSessionCommunicationPolicy(params: {
  config: Pick<OpenClawConfig, "session">;
  entry?: { communication?: SessionCommunicationPolicy };
}): EffectiveSessionCommunicationPolicy {
  const defaults = params.config.session?.communication;
  return {
    send: params.entry?.communication?.send ?? defaults?.send ?? "always",
    receive: params.entry?.communication?.receive ?? defaults?.receive ?? "always",
  };
}

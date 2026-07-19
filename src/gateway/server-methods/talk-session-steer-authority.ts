import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import { createGatewayOperatorTurnAuthority } from "../operator-turn-authority.js";
import type { GatewayClient } from "./shared-types.js";
import type { GatewayRequestContext } from "./types.js";

export function createTalkSessionSteerAuthority(
  client: GatewayClient | null | undefined,
  context: GatewayRequestContext,
  sessionKey: string | undefined,
): TurnAuthoritySnapshot {
  return createGatewayOperatorTurnAuthority({
    client,
    config: context.getRuntimeConfig(),
    sessionKey,
    conversationId: sessionKey,
    trigger: "talk.session.steer",
  });
}

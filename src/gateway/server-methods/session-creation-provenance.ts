import type {
  SessionCreatedActor,
  SessionCreatedVia,
} from "../../config/sessions/session-entry-provenance.js";
import type { GatewayClient } from "./shared-types.js";

export type TrustedSessionCreation = {
  via: SessionCreatedVia;
  actor?: SessionCreatedActor;
};

export function resolveOperatorSessionCreation(
  client: GatewayClient | null,
  options: { allowTrustedHint?: boolean } = {},
): TrustedSessionCreation {
  if (options.allowTrustedHint && client?.internal?.sessionCreation) {
    return client.internal.sessionCreation;
  }
  const profileId = client?.authenticatedUserProfile?.profileId;
  return {
    via: "operator",
    ...(profileId
      ? { actor: { type: "human" as const, id: profileId } }
      : client && client.internal?.syntheticClient !== true
        ? { actor: { type: "human" as const } }
        : {}),
  };
}

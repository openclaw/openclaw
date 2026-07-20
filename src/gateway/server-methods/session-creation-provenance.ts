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
  // Actor only when proven: a profile-less wire connection may be an agent-tool
  // client on a remote topology, so claiming a human actor would misattribute
  // agent-caused creations. Absent actor means unknown, never inferred.
  return {
    via: "operator",
    ...(profileId ? { actor: { type: "human" as const, id: profileId } } : {}),
  };
}

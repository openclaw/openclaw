import type {
  SessionCreatedActor,
  SessionCreatedVia,
} from "../config/sessions/session-entry-provenance.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import type { AgentRuntimeSessionSpawnContext } from "./agent-runtime-session-spawn-context.js";

export type TrustedSessionCreation = Partial<AgentRuntimeSessionSpawnContext> & {
  skillLibrarySelections?: import("../../packages/gateway-protocol/src/schema/skill-library.js").SkillLibrarySelection[];
  via: SessionCreatedVia;
  actor?: SessionCreatedActor;
  /** Creator-owned isolation requirement resolved only by the trusted Gateway boundary. */
  sandbox?: "required";
  /** Exact spawning session retained separately from the stable actor identity. */
  requesterSessionKey?: string;
};

/**
 * Structural subset of GatewayClient; a leaf contract so shared-types.ts can
 * import TrustedSessionCreation without a type cycle back through this module.
 */
type SessionCreationClient = {
  authenticatedUserProfile?: { profileId?: string } | null;
  internal?: {
    syntheticClient?: true;
    sessionCreation?: TrustedSessionCreation;
    agentRuntimeIdentity?: AgentRuntimeIdentity;
  };
};

export function resolveOperatorSessionCreation(
  client: SessionCreationClient | null | undefined,
  options: { allowTrustedHint?: boolean } = {},
): TrustedSessionCreation {
  if (options.allowTrustedHint && client?.internal?.sessionCreation) {
    return client.internal.sessionCreation;
  }
  const agentRuntimeIdentity = client?.internal?.agentRuntimeIdentity;
  if (options.allowTrustedHint && agentRuntimeIdentity?.sessionSpawnContext) {
    const {
      requesterProfileId,
      completionOwnerSessionKey,
      requesterSenderIsOwner,
      inheritedToolPolicy,
      inheritedPermissionMode,
      resolvedModel,
      spawnModelAutoSelection,
    } = agentRuntimeIdentity.sessionSpawnContext;
    return {
      via: "spawn",
      actor: { type: "agent", id: agentRuntimeIdentity.agentId },
      requesterSessionKey: agentRuntimeIdentity.sessionKey,
      ...(requesterProfileId ? { requesterProfileId } : {}),
      ...(completionOwnerSessionKey ? { completionOwnerSessionKey } : {}),
      requesterSenderIsOwner,
      inheritedToolPolicy,
      ...(inheritedPermissionMode ? { inheritedPermissionMode } : {}),
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(spawnModelAutoSelection ? { spawnModelAutoSelection } : {}),
    };
  }
  const profileId = client?.authenticatedUserProfile?.profileId;
  // Profile linking can canonicalize this id after connection attach, so session
  // ownership follows the live trusted profile while audit keeps its frozen facts.
  return {
    via: "operator",
    ...(profileId
      ? { actor: { type: "human" as const, source: "profile" as const, id: profileId } }
      : {}),
  };
}

export function resolveAgentRunSessionCreation(
  client: SessionCreationClient | null | undefined,
): TrustedSessionCreation {
  const actor = resolveOperatorSessionCreation(client).actor;
  return { via: "run", ...(actor ? { actor } : {}) };
}

import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { SessionPermissionMode } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import type {
  SessionCreatedActor,
  SessionCreatedVia,
} from "../../config/sessions/session-entry-provenance.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { AgentRuntimeSpawnModelAutoSelection } from "../agent-runtime-session-spawn-context.js";

export type TrustedSessionCreation = {
  skillLibrarySelections?: import("../../../packages/gateway-protocol/src/schema/skill-library.js").SkillLibrarySelection[];
  via: SessionCreatedVia;
  actor?: SessionCreatedActor;
  /** Creator-owned isolation requirement resolved only by the trusted Gateway boundary. */
  sandbox?: "required";
  /** Exact spawning session retained separately from the stable actor identity. */
  requesterSessionKey?: string;
  /** Host-verified human requester; never accepted from model-authored parameters. */
  requesterProfileId?: string;
  /** Immutable completion recipient for a spawn-owned visible session. */
  completionOwnerSessionKey?: string;
  /** Prepared parent selection; never accepted from public creation parameters. */
  resolvedModel?: ProviderModelRef;
  /** Effective host-prepared permission mode, not a public permission-change request. */
  inheritedPermissionMode?: SessionPermissionMode;
  /** Effective caller tool-policy snapshot for an in-process visible spawn. */
  inheritedToolPolicy?: {
    version: 1;
    allow: string[];
    deny: string[];
  };
  /** Config-selected model provenance from the trusted spawning tool. */
  spawnModelAutoSelection?: AgentRuntimeSpawnModelAutoSelection;
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
    return {
      via: "spawn",
      actor: { type: "agent", id: agentRuntimeIdentity.agentId },
      requesterSessionKey: agentRuntimeIdentity.sessionKey,
      ...(agentRuntimeIdentity.sessionSpawnContext.requesterProfileId
        ? { requesterProfileId: agentRuntimeIdentity.sessionSpawnContext.requesterProfileId }
        : {}),
      ...(agentRuntimeIdentity.sessionSpawnContext.completionOwnerSessionKey
        ? {
            completionOwnerSessionKey:
              agentRuntimeIdentity.sessionSpawnContext.completionOwnerSessionKey,
          }
        : {}),
      inheritedToolPolicy: agentRuntimeIdentity.sessionSpawnContext.inheritedToolPolicy,
      ...(agentRuntimeIdentity.sessionSpawnContext.inheritedPermissionMode
        ? {
            inheritedPermissionMode:
              agentRuntimeIdentity.sessionSpawnContext.inheritedPermissionMode,
          }
        : {}),
      ...(agentRuntimeIdentity.sessionSpawnContext.resolvedModel
        ? { resolvedModel: agentRuntimeIdentity.sessionSpawnContext.resolvedModel }
        : {}),
      ...(agentRuntimeIdentity.sessionSpawnContext.spawnModelAutoSelection
        ? {
            spawnModelAutoSelection:
              agentRuntimeIdentity.sessionSpawnContext.spawnModelAutoSelection,
          }
        : {}),
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

import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { requesterCreatorProfileId, type RequesterOrigin } from "../agents/requester-origin.js";
import { attributeDelegatedSessionCreator } from "../config/sessions/session-entry-provenance.js";
import type {
  SessionCreatedActor,
  SessionCreatedVia,
} from "../config/sessions/session-entry-provenance.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import type { AgentRuntimeSessionSpawnContext } from "./agent-runtime-session-spawn-context.js";
import type { OpenClawIdTunnelPrincipal } from "./openclaw-id/tunnel-principal.js";

export type TrustedSessionCreation = Partial<AgentRuntimeSessionSpawnContext> & {
  skillLibrarySelections?: import("../../packages/gateway-protocol/src/schema/skill-library.js").SkillLibrarySelection[];
  via: SessionCreatedVia;
  surface?: "plugin-dock";
  actor?: SessionCreatedActor;
  /** Creator-owned isolation requirement resolved only by the trusted Gateway boundary. */
  sandbox?: "required";
  /** Attested membership source for creation policy; never persisted as session identity. */
  openclawIdPrincipal?: OpenClawIdTunnelPrincipal;
  /** Exact spawning session retained separately from the stable actor identity. */
  requesterSessionKey?: string;
  /** Live host-only ingress intent; never accepted from wire arguments. */
  childSessionPublication?: import("../channels/message-access/child-session-publication.js").ChildSessionPublication;
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
    agentToolCaller?: {
      agentId: string;
      sessionKey: string;
      requesterOrigin?: RequesterOrigin;
      assertCurrent?: () => void;
    };
    openclawIdPrincipal?: OpenClawIdTunnelPrincipal;
    operatorRunAuthority?: { profileId: string; openclawIdPrincipal?: OpenClawIdTunnelPrincipal };
  };
};

export function resolveOperatorSessionCreation(
  client: SessionCreationClient | null | undefined,
  options: { allowTrustedHint?: boolean } = {},
): TrustedSessionCreation {
  const principal =
    client?.internal?.openclawIdPrincipal ??
    client?.internal?.operatorRunAuthority?.openclawIdPrincipal;
  const memberSource = principal?.kind === "member" ? { openclawIdPrincipal: principal } : {};
  if (options.allowTrustedHint && client?.internal?.sessionCreation) {
    return { ...client.internal.sessionCreation, ...memberSource };
  }
  const agentRuntimeIdentity = client?.internal?.agentRuntimeIdentity;
  if (options.allowTrustedHint && agentRuntimeIdentity?.sessionSpawnContext) {
    const {
      requesterProfileId,
      gitContributorProfileId,
      completionOwnerSessionKey,
      requesterSenderIsOwner,
      inheritedToolPolicy,
      inheritedPermissionMode,
      resolvedModel,
      spawnModelAutoSelection,
    } = agentRuntimeIdentity.sessionSpawnContext;
    return {
      via: "spawn",
      ...memberSource,
      actor: { type: "agent", id: agentRuntimeIdentity.agentId },
      requesterSessionKey: agentRuntimeIdentity.sessionKey,
      ...(requesterProfileId ? { requesterProfileId } : {}),
      ...(gitContributorProfileId ? { gitContributorProfileId } : {}),
      ...(completionOwnerSessionKey ? { completionOwnerSessionKey } : {}),
      requesterSenderIsOwner,
      inheritedToolPolicy,
      ...(inheritedPermissionMode ? { inheritedPermissionMode } : {}),
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(spawnModelAutoSelection ? { spawnModelAutoSelection } : {}),
    };
  }
  const profileId =
    client?.authenticatedUserProfile?.profileId ??
    (principal?.kind === "member" ? client?.internal?.operatorRunAuthority?.profileId : undefined);
  // Profile linking can canonicalize this id after connection attach, so session
  // ownership follows the live trusted profile while audit keeps its frozen facts.
  return {
    via: "operator",
    ...memberSource,
    ...(profileId
      ? { actor: { type: "human" as const, source: "profile" as const, id: profileId } }
      : {}),
  };
}

export function resolveAgentRunSessionCreation(
  client: SessionCreationClient | null | undefined,
): TrustedSessionCreation {
  return { ...resolveOperatorSessionCreation(client), via: "run" };
}

/** Validate the selected execution identity before accepting an operator tool creation. */
export function validateAgentToolSessionCreation(
  client: SessionCreationClient | null | undefined,
  creation: TrustedSessionCreation,
) {
  if (creation.via !== "operator" || creation.requesterSessionKey === undefined) {
    return undefined;
  }
  const caller = client?.internal?.agentToolCaller;
  if (
    !caller?.assertCurrent ||
    caller.sessionKey !== creation.requesterSessionKey ||
    creation.actor?.type !== "human" ||
    creation.actor.source !== "profile" ||
    creation.actor.id !== client?.internal?.operatorRunAuthority?.profileId
  ) {
    return errorShape(
      ErrorCodes.FORBIDDEN,
      "Session creation requires a matching live operator tool caller",
    );
  }
  return undefined;
}

/** After validation, attribution changes only creator controls, never execution identity. */
export function attributeAgentToolSessionCreation(
  creation: TrustedSessionCreation,
  caller: { agentId: string; requesterOrigin?: RequesterOrigin } | undefined,
): TrustedSessionCreation {
  if (creation.via !== "operator" || creation.requesterSessionKey === undefined || !caller) {
    return creation;
  }
  return {
    ...creation,
    actor: attributeDelegatedSessionCreator(
      creation.actor,
      requesterCreatorProfileId(caller.requesterOrigin),
      caller.agentId,
    ),
  };
}

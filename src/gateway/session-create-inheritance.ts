import type { SessionEntry } from "../config/sessions.js";
import {
  inheritSessionCreationPolicy,
  inheritSpawnSessionOwner,
  type SessionOwnerAssignment,
} from "../config/sessions/session-entry-provenance.js";
import { readResidentUserProfileId } from "../state/user-profile-list.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";

type SessionCreation = NonNullable<CreateGatewaySessionParams["creation"]>;

function resolveResidentProfileId(profileId: string): string | undefined {
  try {
    return readResidentUserProfileId(profileId);
  } catch {
    // Catalog readiness never expands ownership: unresolved aliases fall back to the agent.
    return undefined;
  }
}

/** Derives trusted child policy and ownership from the locked spawn parent. */
export function resolveSessionCreateInheritance(params: {
  creation: SessionCreation | undefined;
  parent: SessionEntry | undefined;
}): { creation: SessionCreation | undefined; ownerAssignment?: SessionOwnerAssignment } {
  if (params.creation?.via !== "spawn") {
    return { creation: params.creation };
  }
  const ownerAssignment = inheritSpawnSessionOwner(
    params.parent,
    params.creation.actor,
    params.creation.requesterProfileId,
    Date.now(),
    resolveResidentProfileId,
  );
  return {
    creation: {
      ...params.creation,
      ...inheritSessionCreationPolicy(params.parent, params.creation.actor),
    },
    ...(ownerAssignment ? { ownerAssignment } : {}),
  };
}

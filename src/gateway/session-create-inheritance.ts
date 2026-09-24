import type { SessionEntry } from "../config/sessions.js";
import {
  inheritSessionCreationPolicy,
  type SessionOwnerAssignment,
} from "../config/sessions/session-entry-provenance.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";

type SessionCreation = NonNullable<CreateGatewaySessionParams["creation"]>;

/** The parent supplies isolation; the current human request supplies responsibility. */
export function resolveSessionCreateInheritance(params: {
  creation: SessionCreation | undefined;
  parent: SessionEntry | undefined;
}): { creation: SessionCreation | undefined; ownerAssignment?: SessionOwnerAssignment } {
  if (params.creation?.via !== "spawn") {
    return { creation: params.creation };
  }
  const assignedBy = params.creation.actor;
  const owner = params.creation.requesterProfileId
    ? { type: "human" as const, id: params.creation.requesterProfileId }
    : assignedBy?.type === "agent"
      ? assignedBy
      : undefined;
  return {
    creation: {
      ...params.creation,
      ...inheritSessionCreationPolicy(params.parent, params.creation.actor),
    },
    ...(owner?.id
      ? {
          ownerAssignment: {
            actor: owner,
            ...(assignedBy?.id ? { assignedBy } : {}),
            assignedAt: Date.now(),
          },
        }
      : {}),
  };
}

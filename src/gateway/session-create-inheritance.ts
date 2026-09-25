import { MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE } from "../auto-reply/reply/session-fork.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  inheritSessionCreationPolicy,
  inheritSessionGitContributorProfileIds,
  inheritSpawnSessionOwner,
  type SessionOwnerAssignment,
} from "../config/sessions/session-entry-provenance.js";
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import { waitForSessionParticipantRecording } from "../sessions/session-participant-recording.js";
import { readResidentUserProfileId } from "../state/user-profile-list.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { invalidSessionRequest } from "./session-request-error.js";
import {
  loadGatewaySessionEntryReadOnly,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";

type SessionCreation = NonNullable<CreateGatewaySessionParams["creation"]> &
  Pick<SessionEntry, "inheritedGitContributorProfileIds">;

/** Prepare the parent before lifecycle custody, while accepted input can still settle. */
export async function prepareSessionCreateParent(input: {
  params: Pick<CreateGatewaySessionParams, "cfg" | "creation" | "fork" | "authorizedPluginId">;
  key: string;
  agentId?: string;
  assertCurrent?: () => void;
}) {
  const target = resolveGatewaySessionStoreTarget({
    cfg: input.params.cfg,
    key: input.key,
    ...(input.agentId ? { agentId: input.agentId } : {}),
  });
  if (input.params.creation?.via === "spawn") {
    await waitForSessionParticipantRecording({
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    });
    input.assertCurrent?.();
  }
  const parent = loadGatewaySessionEntryReadOnly(input.key, { agentId: input.agentId });
  if (!parent.entry?.sessionId) {
    return invalidSessionRequest(`unknown parent session: ${input.key}`);
  }
  const ownershipError = resolvePluginSessionOwnershipError({
    action: input.params.fork === true ? "fork" : "link",
    entry: parent.entry,
    key: parent.canonicalKey,
    pluginOwnerId: input.params.authorizedPluginId,
  });
  if (ownershipError) {
    return { ok: false as const, error: ownershipError };
  }
  if (isModelSelectionLocked(parent.entry)) {
    return invalidSessionRequest(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  }
  return { ok: true as const, entry: parent.entry, canonicalKey: parent.canonicalKey, target };
}

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
}): {
  creation: SessionCreation | undefined;
  ownerAssignment?: SessionOwnerAssignment;
} {
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
      inheritedGitContributorProfileIds: inheritSessionGitContributorProfileIds(params.parent),
    },
    ...(ownerAssignment ? { ownerAssignment } : {}),
  };
}

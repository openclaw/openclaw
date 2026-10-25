import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "../agents/inherited-tool-deny.js";
import { MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE } from "../auto-reply/reply/session-fork.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions.js";
import {
  attributeDelegatedSessionCreator,
  inheritSessionCreationPolicy,
  inheritSessionGitContributorProfileIds,
  inheritSpawnSessionOwner,
  type SessionOwnerAssignment,
} from "../config/sessions/session-entry-provenance.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { inheritSessionSelection } from "../config/sessions/session-entry-selection.js";
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import { waitForSessionParticipantRecording } from "../sessions/session-participant-recording.js";
import { readResidentUserProfileId } from "../state/user-profile-list.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { invalidSessionRequest } from "./session-request-error.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

type SessionCreation = NonNullable<CreateGatewaySessionParams["creation"]> &
  Pick<SessionEntry, "inheritedGitContributorProfileIds">;

/** Inherit parent selection without replacing explicitly requested choices. */
export function inheritSessionCreateParentFields(params: {
  parent: SessionEntry | undefined;
  newExplicitChild: boolean;
  newDashboardRoot: boolean;
  selectedModel?: string;
  overrides: Pick<
    CreateGatewaySessionParams,
    | "catalogTarget"
    | "model"
    | "toolOverrides"
    | "fastMode"
    | "communication"
    | "cyberAccessProgram"
  >;
}): Partial<InternalSessionEntry> {
  const { parent, overrides } = params;
  const inherited =
    overrides.catalogTarget?.model.trim() || overrides.model?.trim()
      ? {}
      : inheritSessionSelection(parent);
  if (overrides.toolOverrides !== undefined) {
    delete inherited.toolOverrides;
  }
  if (overrides.cyberAccessProgram !== undefined) {
    delete inherited.cyberAccessProgram;
  }
  if (overrides.fastMode !== undefined) {
    // Explicit choices have already been validated by the canonical patch owner.
    delete inherited.fastMode;
  }
  // Communication inheritance initializes only a new explicit child. Adopting a
  // key or automatically grouping a dashboard root cannot replace its policy.
  if (params.newExplicitChild && overrides.communication === undefined && parent?.communication) {
    inherited.communication = { ...parent.communication };
  }
  // Main groups dashboard roots; it must not supply their reply-time model.
  if (params.newDashboardRoot && !params.selectedModel) {
    inherited.modelOverrideSource = "default";
  }
  // A dashboard root is a direct chat with its operator, whichever turn path
  // (chat.send, sessions_send, cron) first runs it. Memory audience resolution
  // reads this durable root fact; each turn still decides owner status.
  if (params.newDashboardRoot) {
    inherited.chatType = "direct";
  }
  return inherited;
}

/** Prepare the parent before lifecycle custody, while accepted input can still settle. */
export async function prepareSessionCreateParent(input: {
  params: Pick<CreateGatewaySessionParams, "cfg" | "creation" | "fork" | "authorizedPluginId">;
  key: string;
  agentId?: string;
  assertCurrent?: () => void;
}) {
  const target = await resolveGatewaySessionStoreTargetInWorker({
    cfg: input.params.cfg,
    key: input.key,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    assertActive: input.assertCurrent,
    projection: "full",
  });
  let entry = findCanonicalStoreMatch(target.store, target.storeKeys)?.entry;
  if (input.params.creation?.via === "spawn") {
    await waitForSessionParticipantRecording({
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    });
    input.assertCurrent?.();
    entry = await readSessionEntryReadOnlyInWorker({
      agentId: target.agentId,
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
    });
    input.assertCurrent?.();
  }
  if (!entry?.sessionId) {
    return invalidSessionRequest(`unknown parent session: ${input.key}`);
  }
  const ownershipError = resolvePluginSessionOwnershipError({
    action: input.params.fork === true ? "fork" : "link",
    entry,
    key: target.canonicalKey,
    pluginOwnerId: input.params.authorizedPluginId,
  });
  if (ownershipError) {
    return { ok: false as const, error: ownershipError };
  }
  if (isModelSelectionLocked(entry)) {
    return invalidSessionRequest(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  }
  return { ok: true as const, entry, canonicalKey: target.canonicalKey, target };
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
  request: Pick<CreateGatewaySessionParams, "cfg" | "creation">;
  parent: {
    entry: SessionEntry | undefined;
    target: { agentId: string; canonicalKey: string } | undefined;
  };
}): {
  creation: SessionCreation | undefined;
  ownerAssignment?: SessionOwnerAssignment;
} {
  if (params.request.creation?.via !== "spawn") {
    return { creation: params.request.creation };
  }
  const ownerAssignment = inheritSpawnSessionOwner(
    params.parent.entry,
    params.request.creation.actor,
    params.request.creation.requesterProfileId,
    Date.now(),
    resolveResidentProfileId,
  );
  const policy = inheritSessionCreationPolicy(params.parent.entry, params.request.creation.actor);
  return {
    creation: {
      ...params.request.creation,
      ...policy,
      actor: attributeDelegatedSessionCreator(
        policy.actor,
        params.request.creation.actor?.delegatedBy?.type === "human"
          ? params.request.creation.actor.delegatedBy.id
          : undefined,
        params.request.creation.actor?.type === "agent"
          ? params.request.creation.actor.id
          : undefined,
      ),
      inheritedGitContributorProfileIds: params.parent.target
        ? inheritSessionGitContributorProfileIds(params.parent.entry, {
            config: params.request.cfg,
            agentId: params.parent.target.agentId,
            sessionKey: params.parent.target.canonicalKey,
            requesterProfileId: params.request.creation.gitContributorProfileId,
          })
        : [],
    },
    ...(ownerAssignment ? { ownerAssignment } : {}),
  };
}

/** Project the trusted spawn policy only onto a genuinely new child row. */
export function resolveSessionCreateSpawnPolicy(
  params: Pick<CreateGatewaySessionParams, "spawnToolPolicy" | "preparedPermissionSelection">,
  parentSessionKey: string | undefined,
): Partial<SessionEntry> | undefined {
  if (!params.spawnToolPolicy || !parentSessionKey) {
    return undefined;
  }
  const completionOwnerSessionKey = normalizeOptionalString(
    params.spawnToolPolicy.completionOwnerSessionKey,
  );
  const allow = normalizeInheritedToolAllowlist(params.spawnToolPolicy.allow);
  const deny = normalizeInheritedToolDenylist(params.spawnToolPolicy.deny);
  return {
    spawnedBy: parentSessionKey,
    ...(completionOwnerSessionKey ? { completionOwnerSessionKey } : {}),
    inheritedToolPolicyVersion: 1,
    ...(params.spawnToolPolicy.delegatedToolPolicy
      ? { delegatedToolPolicy: params.spawnToolPolicy.delegatedToolPolicy }
      : {}),
    ...(params.preparedPermissionSelection
      ? { permissionMode: params.preparedPermissionSelection.mode }
      : {}),
    ...(allow.length > 0 ? { inheritedToolAllow: allow } : {}),
    ...(deny.length > 0 ? { inheritedToolDeny: deny } : {}),
  };
}

import type { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPairedDevicePairingStoreRecordFromDatabase } from "../infra/device-pairing-store.js";
import { hasEffectivePairedDeviceRole, resolveNodePairingState } from "../infra/device-pairing.js";
import type { LiveActivityBinding } from "../infra/push-live-activity-store.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { selectResolvedUserProfileById } from "../state/user-profiles-internal.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { createProfileSessionEntryFilter } from "./session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

function readProfile(profileId: string, database?: DatabaseSync) {
  const read = (db: DatabaseSync) =>
    tableExists(db, "user_profiles") ? selectResolvedUserProfileById(db, profileId) : undefined;
  return database
    ? read(database)
    : withExistingOpenClawStateDatabaseReadOnly(({ db }) => read(db));
}

export function liveActivityScopesAllow(scopes: readonly string[], scope: string): boolean {
  return roleScopesAllow({
    role: "operator",
    requestedScopes: [scope],
    allowedScopes: [...scopes],
  });
}

/** Read existing authority only. Preparation must not materialize profiles or pairing state. */
export function readLiveActivityOwner(
  profileId: string,
  deviceId: string,
  cfg: OpenClawConfig,
  database?: DatabaseSync,
) {
  const read = (db: DatabaseSync) => {
    if (!tableExists(db, "user_profiles") || !tableExists(db, "device_pairing_paired")) {
      return undefined;
    }
    const profile = selectResolvedUserProfileById(db, profileId);
    const paired = loadPairedDevicePairingStoreRecordFromDatabase(db, deviceId);
    const node = resolveNodePairingState(paired);
    if (
      !profile ||
      profile.merged_into ||
      profile.id !== profileId ||
      !paired ||
      !hasEffectivePairedDeviceRole(paired, "operator") ||
      node?.identity.nodeId !== deviceId ||
      node.generation?.nodeId !== deviceId
    ) {
      return undefined;
    }
    const policy = resolveOperatorRolePolicyForAssignment(profile.id, profile.role ?? null, cfg);
    const granted = paired.tokens?.operator?.scopes ?? [];
    const scopes = policy
      ? [...new Set([...granted, ...policy.scopes])].filter(
          (scope) =>
            liveActivityScopesAllow(granted, scope) &&
            liveActivityScopesAllow(policy.scopes, scope),
        )
      : granted;
    return {
      profileId: profile.id,
      deviceId,
      nodeId: node.identity.nodeId,
      pairingGeneration: node.generation.key,
      scopes,
      policy,
    };
  };
  return database
    ? read(database)
    : withExistingOpenClawStateDatabaseReadOnly(({ db }) => read(db));
}

export function readLiveActivitySession(
  target: Pick<LiveActivityBinding, "agentId" | "sessionKey" | "sessionId" | "lifecycleRevision">,
  owner: NonNullable<ReturnType<typeof readLiveActivityOwner>>,
  cfg: OpenClawConfig,
  database?: DatabaseSync,
) {
  const agent = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
  if (
    !agent.ok ||
    agent.agentId !== target.agentId ||
    (owner.policy && owner.policy.agents !== "*" && !owner.policy.agents.includes(target.agentId))
  ) {
    return undefined;
  }
  const loaded = loadGatewaySessionEntryReadOnly(target.sessionKey, { agentId: target.agentId });
  const entry = loaded.entry;
  if (
    !entry ||
    loaded.canonicalKey !== target.sessionKey ||
    loaded.agentId !== target.agentId ||
    entry.sessionId !== target.sessionId ||
    (entry.lifecycleRevision ?? null) !== target.lifecycleRevision ||
    entry.archivedAt !== undefined ||
    entry.incognito === true ||
    isIncognitoSessionKey(loaded.canonicalKey)
  ) {
    return undefined;
  }
  const visible = createProfileSessionEntryFilter(
    { profileId: owner.profileId, sessionCap: owner.policy?.sessions.others },
    (actor) => {
      if (actor?.type !== "human" || !actor.id) {
        return false;
      }
      const creator = readProfile(actor.id, database);
      return creator?.id === owner.profileId && !creator.merged_into;
    },
  );
  return liveActivityScopesAllow(owner.scopes, "operator.admin") ||
    visible(loaded.canonicalKey, entry)
    ? loaded
    : undefined;
}

/** Offline delivery deliberately has no websocket membership or request signal dependency. */
export function isLiveActivityBindingCurrent(
  binding: Readonly<LiveActivityBinding>,
  cfg: OpenClawConfig,
  database?: DatabaseSync,
): boolean {
  const owner = readLiveActivityOwner(binding.profileId, binding.deviceId, cfg, database);
  return Boolean(
    owner &&
    owner.profileId === binding.profileId &&
    owner.nodeId === binding.nodeId &&
    owner.pairingGeneration === binding.pairingGeneration &&
    liveActivityScopesAllow(owner.scopes, "operator.write") &&
    readLiveActivitySession(binding, owner, cfg, database),
  );
}

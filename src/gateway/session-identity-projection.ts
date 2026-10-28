import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionCreatedActor,
  SessionOwner,
  SessionPerson,
  SessionParticipant,
  SessionParticipantIdentity,
} from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import {
  resolveSessionCreatorActor,
  sessionCreatorProfileId,
  type SessionActor,
} from "../config/sessions/session-entry-provenance.js";
import { mergeSessionProfileInvolvement } from "../config/sessions/session-involvement.js";
import type {
  InternalSessionEntry as SessionEntry,
  SessionProfileInvolvement,
} from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isAvatarDataUrl, isAvatarHttpUrl, looksLikeAvatarPath } from "../shared/avatar-policy.js";
import { SESSIONS_LIST_OWNER_LIMIT } from "../shared/session-list-limits.js";
import type { SessionOwnerFacetIdentity } from "../shared/session-types.js";
import { sortAndLimitBy } from "../shared/sort-and-limit.js";
import { resolveUserProfileReference } from "../state/user-profile-list.js";
import type { UserProfileIdentity } from "../state/user-profiles.types.js";
import { prepareGatewayAvatarDataUrl } from "./assistant-avatar-cache.js";
import { gatewayAssistantAvatarUrl } from "./assistant-avatar.js";
import { buildControlUiResourcePath } from "./control-ui-contract.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import {
  resolveCurrentUserProfileDisplay,
  type CurrentUserProfileDisplay,
} from "./current-user-profile-display.js";
import type { SessionEntryPair } from "./session-list-order.js";

export type SessionActorProfileIdentity = Extract<CurrentUserProfileDisplay, { kind: "resolved" }>;
export type SessionIdentityProjection = ReturnType<typeof createSessionIdentityProjection>;

/** The row owner invalidates these facts on profile/config publication; entry replacement is exact. */
export function createSessionIdentityProjection() {
  let revision = {};
  let owners = new WeakMap<SessionEntry, ReturnType<typeof projectSessionOwner> | null>();
  let participants = new WeakMap<SessionEntry, ReadonlyMap<string, SessionParticipant>>();
  let people = new WeakMap<SessionEntry, readonly SessionPerson[]>();
  let involvement = new WeakMap<SessionEntry, Map<string, SessionProfileInvolvement>>();
  return {
    get revision() {
      return revision;
    },
    invalidate() {
      revision = {};
      owners = new WeakMap();
      participants = new WeakMap();
      people = new WeakMap();
      involvement = new WeakMap();
    },
    involvement(
      this: void,
      entry: SessionEntry,
      profiles: Parameters<typeof projectSessionProfileInvolvements>[1],
    ): ReadonlyMap<string, SessionProfileInvolvement> {
      let projected = involvement.get(entry);
      if (!projected) {
        projected = projectSessionProfileInvolvements(entry, profiles);
        involvement.set(entry, projected);
      }
      return projected;
    },
    owner: ((entry, profiles, cfg, configuredAgentIds) => {
      if (!entry) {
        return undefined;
      }
      let projected = owners.get(entry);
      if (projected === undefined) {
        projected = projectSessionOwner(entry, profiles, cfg, configuredAgentIds) ?? null;
        owners.set(entry, projected);
      }
      return projected ?? undefined;
    }) satisfies typeof projectSessionOwner,
    participants(
      this: void,
      ...args: Parameters<typeof projectSessionParticipants>
    ): ReadonlyMap<string, SessionParticipant> {
      const [entry] = args;
      if (!entry) {
        return projectSessionParticipants(...args);
      }
      let projected = participants.get(entry);
      if (!projected) {
        projected = projectSessionParticipants(...args);
        participants.set(entry, projected);
      }
      return projected;
    },
    people(this: void, ...args: Parameters<typeof projectSessionPeople>): readonly SessionPerson[] {
      const [entry] = args;
      let projected = people.get(entry);
      if (!projected) {
        projected = projectSessionPeople(...args);
        people.set(entry, projected);
      }
      return projected;
    },
  };
}

export function resolveSessionProfileId(
  id: string,
  profiles: Map<string, SessionActorProfileIdentity | undefined>,
): string {
  if (!profiles.has(id)) {
    const display = resolveCurrentUserProfileDisplay(id);
    profiles.set(id, display.kind === "resolved" ? display : undefined);
  }
  return profiles.get(id)?.profileId ?? id;
}

/** Session rows share the agent-list URL contract: remote sources stay external; data URLs get a revision. */
function projectAgentAvatarUrl(
  cfg: OpenClawConfig,
  agentId: string,
  avatar: string,
): { avatarUrl?: string } {
  if (isAvatarHttpUrl(avatar)) {
    return { avatarUrl: avatar };
  }
  const basePath = normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath);
  if (isAvatarDataUrl(avatar)) {
    const image = prepareGatewayAvatarDataUrl(cfg, agentId, avatar);
    return image ? { avatarUrl: gatewayAssistantAvatarUrl({ image }, basePath, agentId) } : {};
  }
  return looksLikeAvatarPath(avatar)
    ? { avatarUrl: buildControlUiResourcePath("agentAvatar", basePath, agentId) }
    : {};
}

export function projectSessionParticipant(
  identity: SessionParticipantIdentity,
  profiles: Map<string, SessionActorProfileIdentity | undefined>,
  cfg?: OpenClawConfig,
): SessionParticipant {
  if (identity.type === "agent" && cfg) {
    const agent = resolveAgentIdentity(cfg, identity.id);
    const label = normalizeOptionalString(agent?.name);
    const avatar = normalizeOptionalString(agent?.avatar);
    return {
      identity,
      ...(label ? { label } : {}),
      ...(avatar ? projectAgentAvatarUrl(cfg, identity.id, avatar) : {}),
    };
  }
  if (identity.type !== "profile") {
    return { identity };
  }
  const id = resolveSessionProfileId(identity.id, profiles);
  const profile = profiles.get(identity.id);
  return {
    identity: { type: "profile", id },
    ...(profile?.label ? { label: profile.label } : {}),
    ...(profile?.hasUploadedAvatar ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

/** Resolve merged profiles without rewriting personal choices in other agent stores. */
export function projectSessionProfileInvolvements(
  entry: SessionEntry,
  profiles: Map<string, SessionActorProfileIdentity | undefined>,
): Map<string, SessionProfileInvolvement> {
  const projected = new Map<string, SessionProfileInvolvement>();
  for (const [id, state] of Object.entries(entry.profileInvolvement?.profiles ?? {})) {
    const canonical = resolveSessionProfileId(id, profiles);
    const merged = mergeSessionProfileInvolvement([projected.get(canonical), state]);
    if (merged) {
      projected.set(canonical, merged);
    }
  }
  return projected;
}

export function projectSessionActor(
  actor: SessionActor | undefined,
  profiles: Map<string, SessionActorProfileIdentity | undefined> = new Map(),
  cfg?: OpenClawConfig,
  profileProvenance = true,
): SessionCreatedActor | undefined {
  if (!actor) {
    return undefined;
  }
  const id = normalizeOptionalString(actor.id);
  if (!id) {
    return { type: actor.type };
  }
  const identity: SessionParticipantIdentity =
    actor.type === "agent"
      ? { type: "agent", id }
      : actor.type === "human" && profileProvenance
        ? { type: "profile", id }
        : { type: "legacy", actorType: actor.type, source: null, id };
  // Keep original attribution in the display; authority reads the qualified canonical actor.
  return { type: actor.type, id, ...projectSessionParticipant(identity, profiles, cfg) };
}

/** Projects an identity only when it can own a session durably. */
export function projectAssignableSessionOwner(
  actor: SessionActor | undefined,
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined>,
  cfg: OpenClawConfig,
  configuredAgentIds?: ReadonlySet<string>,
  profileProvenance = true,
): SessionOwnerFacetIdentity | undefined {
  if (!actor || (actor.type !== "human" && actor.type !== "agent")) {
    return undefined;
  }
  const rawId = normalizeOptionalString(actor.id);
  if (!rawId) {
    return undefined;
  }
  const id = actor.type === "agent" ? normalizeAgentId(rawId) : rawId;
  if (actor.type === "agent" && !(configuredAgentIds ?? new Set(listAgentIds(cfg))).has(id)) {
    return undefined;
  }
  if (actor.type === "human" && !profileProvenance) {
    return undefined;
  }
  const projected = projectSessionActor({ type: actor.type, id }, userProfileIdentityById, cfg);
  if (!projected?.id || (actor.type === "human" && userProfileIdentityById.get(id) === undefined)) {
    return undefined;
  }
  return { ...projected, type: actor.type, id };
}

export function projectSessionOwner(
  entry: SessionEntry | undefined,
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined> | undefined,
  cfg: OpenClawConfig,
  configuredAgentIds?: ReadonlySet<string>,
): (SessionOwner & { actor: SessionOwnerFacetIdentity }) | undefined {
  const persisted = entry?.owner;
  const identities = userProfileIdentityById ?? new Map();
  const actor = projectAssignableSessionOwner(
    persisted?.actor ?? resolveSessionCreatorActor(entry?.createdActor),
    identities,
    cfg,
    configuredAgentIds,
    Boolean(persisted?.actor || sessionCreatorProfileId(entry?.createdActor)),
  );
  if (!actor) {
    return undefined;
  }
  const assignedBy = projectSessionActor(persisted?.assignedBy, identities, cfg);
  return {
    actor,
    ...(assignedBy ? { assignedBy } : {}),
    ...(persisted?.assignedAt !== undefined ? { assignedAt: persisted.assignedAt } : {}),
  };
}

export function projectSessionParticipants(
  entry: SessionEntry | undefined,
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined> | undefined,
  cfg: OpenClawConfig,
): Map<string, SessionParticipant> {
  const identities = userProfileIdentityById ?? new Map();
  const participants = new Map<string, SessionParticipant>();
  for (const { identity } of entry?.participants ?? []) {
    const participant = projectSessionParticipant(identity, identities, cfg);
    participants.set(JSON.stringify(participant.identity), participant);
  }
  return participants;
}

/** Match canonical owners or profile participants, never mentions or display-reference prefixes. */
export function filterSessionEntriesByProfile<T extends { entry: SessionEntry }>(params: {
  entries: T[];
  profile: UserProfileIdentity | undefined;
}): T[] {
  const profile = params.profile;
  if (!profile) {
    return [];
  }
  return params.entries.filter(({ entry }) => {
    const owner = entry.owner?.actor;
    const ownerId = owner
      ? owner.type === "human"
        ? normalizeOptionalString(owner.id)
        : undefined
      : sessionCreatorProfileId(entry.createdActor);
    return (
      (ownerId !== undefined && profile.aliases.has(ownerId)) ||
      (entry.participants ?? []).some(
        ({ identity }) => identity.type === "profile" && profile.aliases.has(identity.id),
      )
    );
  });
}

/** Participation, creation, and responsibility are associations, never access grants. */
export function projectSessionPeople(
  entry: SessionEntry,
  identities: Map<string, SessionActorProfileIdentity | undefined>,
  owner?: SessionOwnerFacetIdentity,
): SessionPerson[] {
  const people = new Map<string, SessionPerson>();
  const addPerson = (participant: SessionParticipant | SessionOwnerFacetIdentity | undefined) => {
    const identity = participant?.identity;
    if (identity?.type === "profile") {
      people.set(identity.id, {
        identity,
        label: participant?.label,
        avatarUrl: participant?.avatarUrl,
        sessionCount: 1,
      });
    }
  };
  for (const { identity } of entry.participants ?? []) {
    if (identity.type === "profile") {
      addPerson(projectSessionParticipant(identity, identities));
    }
  }
  addPerson(owner);
  const creatorId = normalizeOptionalString(sessionCreatorProfileId(entry.createdActor));
  if (creatorId) {
    addPerson(projectSessionParticipant({ type: "profile", id: creatorId }, identities));
  }
  return [...people.values()];
}

/** Resolve navigation references within the caller-prepared visibility scope. */
export function resolveSessionListProfileReference(
  reference: string,
  entries: readonly SessionEntryPair[],
  identities: Map<string, SessionActorProfileIdentity | undefined>,
  allowedProfileIds: ReadonlySet<string> | undefined,
): Result<string | undefined, "ambiguous"> {
  const exact = resolveSessionProfileId(reference, identities);
  if (identities.get(reference) && (!allowedProfileIds || allowedProfileIds.has(exact))) {
    return ok(exact);
  }
  // Compare retained IDs directly; normalizing each association allocates per visible row.
  const prefix = /^[0-9a-f]{8,32}$/.test(reference)
    ? new RegExp(`^-*${reference.split("").join("-*")}`, "i")
    : undefined;
  const matches = new Set<string>();
  const matchesReference = (id: string | undefined) => {
    if (id && prefix?.test(id)) {
      matches.add(resolveSessionProfileId(id, identities));
    }
    return id === reference;
  };
  const matchesParticipant = ({ identity }: SessionParticipant) =>
    identity.type === "profile" && matchesReference(identity.id);
  // Qualified associations outlive profile rows. Resolve over caller-visible identities
  // before time/search filters so hidden associations cannot affect the result.
  for (const [, entry] of entries) {
    if (
      matchesReference(sessionCreatorProfileId(entry.createdActor)) ||
      entry.participants?.some(matchesParticipant)
    ) {
      return ok(exact);
    }
  }
  const durable = resolveUserProfileReference(
    reference,
    allowedProfileIds ? { allowedProfileIds } : {},
  );
  if (!durable.ok) {
    return durable;
  }
  if (durable.value) {
    matches.add(durable.value);
  }
  return matches.size > 1 ? err("ambiguous") : ok(matches.values().next().value);
}

export function projectSessionPeopleFacet(
  people: ReadonlyMap<string, SessionPerson>,
  selectedProfileId?: string,
) {
  const entries = [...people.values()];
  const compare = (a: SessionPerson, b: SessionPerson) =>
    b.sessionCount - a.sessionCount ||
    (a.label ?? a.identity.id).localeCompare(b.label ?? b.identity.id) ||
    a.identity.id.localeCompare(b.identity.id);
  const visiblePeople = sortAndLimitBy(entries, SESSIONS_LIST_OWNER_LIMIT, compare);
  const selected = selectedProfileId ? people.get(selectedProfileId) : undefined;
  if (selected && !visiblePeople.includes(selected)) {
    visiblePeople.splice(-1, 1, selected);
  }
  return { people: visiblePeople, selected, overflow: entries.length > visiblePeople.length };
}

export function addSessionOwnerFacetIdentity(
  ownerFacet: Map<string, SessionOwnerFacetIdentity>,
  actor: SessionOwnerFacetIdentity,
): void {
  const existing = ownerFacet.get(actor.id);
  // The wire filter is id-only; a configured agent wins an authoritative namespace collision.
  if (!existing || (existing.type === "human" && actor.type === "agent")) {
    ownerFacet.set(actor.id, actor);
  }
}

export function sortSessionOwnerFacet(
  ownerFacet: Map<string, SessionOwnerFacetIdentity>,
): SessionOwnerFacetIdentity[] {
  return [...ownerFacet.values()].toSorted((a, b) => {
    const byLabel = (a.label ?? a.id).localeCompare(b.label ?? b.id);
    return byLabel || a.id.localeCompare(b.id);
  });
}

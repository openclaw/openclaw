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
import { looksLikeAvatarPath } from "../shared/avatar-policy.js";
import { SESSIONS_LIST_OWNER_LIMIT } from "../shared/session-list-limits.js";
import type { SessionOwnerFacetIdentity } from "../shared/session-types.js";
import { sortAndLimitBy } from "../shared/sort-and-limit.js";
import type { SynchronousWork } from "../shared/synchronous-work.js";
import {
  getUserProfileDisplays,
  readUserProfileIdentity,
  resolveUserProfileReference,
} from "../state/user-profile-list.js";
import { buildControlUiResourcePath, buildControlUiUserAvatarPath } from "./control-ui-contract.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import type { SessionEntryPair } from "./session-list-order.js";
import type {
  SessionActorProfileIdentity,
  SessionIdentityProjection,
} from "./session-utils-contracts.js";

/** The row owner invalidates these facts on profile/config publication; entry replacement is exact. */
export function createSessionIdentityProjection(): SessionIdentityProjection {
  let owners = new WeakMap<SessionEntry, ReturnType<typeof projectSessionOwner>>();
  let participants = new WeakMap<SessionEntry, ReadonlyMap<string, SessionParticipant>>();
  let people = new WeakMap<SessionEntry, readonly SessionPerson[]>();
  return {
    invalidate() {
      owners = new WeakMap();
      participants = new WeakMap();
      people = new WeakMap();
    },
    owner(this: void, ...args: Parameters<typeof projectSessionOwner>) {
      const [entry] = args;
      if (!entry) {
        return projectSessionOwner(...args);
      }
      if (!owners.has(entry)) {
        owners.set(entry, projectSessionOwner(...args));
      }
      return owners.get(entry);
    },
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
      ...(avatar && looksLikeAvatarPath(avatar)
        ? {
            avatarUrl: buildControlUiResourcePath(
              "agentAvatar",
              normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath),
              identity.id,
            ),
          }
        : {}),
    };
  }
  if (identity.type !== "profile") {
    return { identity };
  }
  if (!profiles.has(identity.id)) {
    const display = resolveCurrentUserProfileDisplay(identity.id);
    profiles.set(identity.id, display.kind === "resolved" ? display : undefined);
  }
  const profile = profiles.get(identity.id);
  return {
    identity: { type: "profile", id: profile?.profileId ?? identity.id },
    ...(profile?.label ? { label: profile.label } : {}),
    ...(profile?.hasUploadedAvatar ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

/** Resolve merged profiles without rewriting personal choices in other agent stores. */
export function projectSessionProfileInvolvement(
  entry: SessionEntry,
  profileId: string,
  profiles: Map<string, SessionActorProfileIdentity | undefined>,
): SessionProfileInvolvement | undefined {
  return mergeSessionProfileInvolvement(
    Object.entries(entry.profileInvolvement?.profiles ?? {}).flatMap(([id, state]) =>
      projectSessionParticipant({ type: "profile", id }, profiles).identity.id === profileId
        ? [state]
        : [],
    ),
  );
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
    persisted?.actor ?? entry?.createdActor,
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

/** Filter stored rows using exact durable identity, never display-reference prefixes. */
export function filterSessionEntriesByProfile<T extends { entry: SessionEntry }>(params: {
  entries: T[];
  profileId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): T[] {
  const profile = readUserProfileIdentity(params.profileId, { env: params.env });
  if (!profile) {
    return [];
  }
  const ids = new Set<string>();
  for (const { entry } of params.entries) {
    for (const id of [
      normalizeOptionalString(
        entry.owner?.actor.type === "human" ? entry.owner.actor.id : undefined,
      ),
      normalizeOptionalString(sessionCreatorProfileId(entry.createdActor)),
      normalizeOptionalString(
        entry.owner?.assignedBy?.type === "human" ? entry.owner.assignedBy.id : undefined,
      ),
      ...(entry.participants ?? []).flatMap(({ identity }) =>
        identity.type === "profile" ? [identity.id] : [],
      ),
      ...Object.keys(entry.profileInvolvement?.profiles ?? {}),
    ]) {
      if (id) {
        ids.add(id);
      }
    }
  }
  const displays = getUserProfileDisplays([...ids], { env: params.env });
  const identities = new Map<string, SessionActorProfileIdentity | undefined>();
  for (const id of ids) {
    const display = displays.get(id);
    identities.set(
      id,
      display
        ? {
            kind: "resolved",
            profileId: display.id,
            avatarUrl: buildControlUiUserAvatarPath(display.id, display.avatarRevision),
            hasUploadedAvatar: display.hasAvatar,
          }
        : undefined,
    );
  }
  return params.entries.filter(({ entry }) =>
    matchesSessionProfileInvolvement({
      entry,
      profileId: profile.profileId,
      identities,
      cfg: params.cfg,
      effectiveOwner: projectSessionOwner(entry, identities, params.cfg)?.actor,
    }),
  );
}

/** Shared person-involvement semantics for Activity and source catalog selection. */
export function matchesSessionProfileInvolvement(params: {
  entry: SessionEntry;
  profileId: string;
  identities: Map<string, SessionActorProfileIdentity | undefined>;
  cfg: OpenClawConfig;
  effectiveOwner?: SessionOwnerFacetIdentity;
  personal?: boolean;
  projectParticipants?: SessionIdentityProjection["participants"];
}): boolean {
  const { entry, profileId, identities, cfg, effectiveOwner, personal = false } = params;
  const state = projectSessionProfileInvolvement(entry, profileId, identities);
  return (
    !(personal && state?.hidden) &&
    (Boolean(state?.lastMention || (personal && state?.hidden === false)) ||
      (effectiveOwner?.identity?.type === "profile" && effectiveOwner.identity.id === profileId) ||
      (params.projectParticipants ?? projectSessionParticipants)(entry, identities, cfg).has(
        JSON.stringify({ type: "profile", id: profileId }),
      ))
  );
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
export function* resolveSessionListProfileReference(
  reference: string,
  entries: readonly SessionEntryPair[],
  identities: Map<string, SessionActorProfileIdentity | undefined>,
  allowedProfileIds: ReadonlySet<string> | undefined,
  shouldYield?: () => boolean,
): SynchronousWork<Result<string | undefined, "ambiguous">> {
  const exact = projectSessionParticipant({ type: "profile", id: reference }, identities);
  if (
    identities.get(reference) &&
    (!allowedProfileIds || allowedProfileIds.has(exact.identity.id))
  ) {
    return ok(exact.identity.id);
  }
  const prefix = /^[0-9a-f]{8,32}$/.test(reference);
  const matches = new Set<string>();
  // Qualified associations outlive profile rows. Resolve over caller-visible identities
  // before time/search filters so hidden associations cannot affect the result.
  for (const [, entry] of entries) {
    if (shouldYield?.()) {
      yield;
    }
    const ids = [
      sessionCreatorProfileId(entry.createdActor),
      ...(entry.participants ?? []).flatMap(({ identity }) =>
        identity.type === "profile" ? [identity.id] : [],
      ),
    ];
    for (const id of ids) {
      if (id === reference) {
        return ok(exact.identity.id);
      }
      if (id && prefix && id.replaceAll("-", "").toLowerCase().startsWith(reference)) {
        matches.add(projectSessionParticipant({ type: "profile", id }, identities).identity.id);
      }
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
  people: Iterable<SessionPerson>,
  selectedProfileId?: string,
) {
  const entries = [...people];
  const compare = (a: SessionPerson, b: SessionPerson) =>
    b.sessionCount - a.sessionCount ||
    (a.label ?? a.identity.id).localeCompare(b.label ?? b.identity.id) ||
    a.identity.id.localeCompare(b.identity.id);
  const visiblePeople = sortAndLimitBy(entries, SESSIONS_LIST_OWNER_LIMIT, compare);
  const selected = selectedProfileId
    ? sortAndLimitBy(
        entries.filter((person) => person.identity.id === selectedProfileId),
        1,
        compare,
      )[0]
    : undefined;
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

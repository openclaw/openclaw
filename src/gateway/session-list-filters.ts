import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  MAX_SESSION_PARTICIPANTS,
  sessionCreatorProfileId,
} from "../config/sessions/session-entry-provenance.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isCronRunSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { sessionActivityTimestamp } from "../shared/session-activity-timestamp.js";
import type { SessionOwnerFacetIdentity } from "../shared/session-types.js";
import type { SynchronousWork } from "../shared/synchronous-work.js";
import {
  projectSessionOwner,
  addSessionOwnerFacetIdentity,
  sortSessionOwnerFacet,
  projectSessionParticipants,
  projectSessionParticipant,
  projectSessionPeople,
  projectSessionPeopleFacet,
  resolveSessionListProfileReference,
} from "./session-identity-projection.js";
import type { SessionEntryPair } from "./session-list-order.js";
import type { SessionListTargetLookup } from "./session-list-target.js";
import type {
  SessionActorProfileIdentity,
  SessionListActiveRunProjector,
  SessionListRowContext,
  SessionListRowContextProvider,
} from "./session-utils-contracts.js";
import { isFinitePositiveTimestamp, resolveSessionChildOwners } from "./session-utils-core.js";
import { createSessionListSearchMatcher } from "./session-utils-search.js";
import type { SessionListModelCatalog, SessionsListResult } from "./session-utils.types.js";

export type SessionListFilteredEntries = {
  entries: SessionEntryPair[];
  ownerEntries: SessionEntryPair[];
  ownerFacet: SessionOwnerFacetIdentity[];
  people?: SessionsListResult["people"];
  peopleIncomplete?: boolean;
  peopleSessionCount?: number;
  involvingProfileId?: string;
};

export type SessionListFilterParams = {
  cfg: OpenClawConfig;
  entries: Iterable<SessionEntryPair>;
  getTarget: SessionListTargetLookup;
  modelCatalog?: SessionListModelCatalog | ModelCatalogEntry[];
  opts: SessionsListParams;
  now: number;
  userProfileIdentityById?: Map<string, SessionActorProfileIdentity | undefined>;
  configuredAgentIds?: ReadonlySet<string>;
  getRowContext: SessionListRowContextProvider;
  entryFilter?: (key: string, entry: SessionEntry) => boolean;
  restrictProfileReferences?: boolean;
  involvingActorId?: string;
  ownerFirstActorId?: string;
  projectActiveRun?: SessionListActiveRunProjector;
  shouldYield?: () => boolean;
};

export function* filterSessionEntries(
  params: SessionListFilterParams,
): SynchronousWork<SessionListFilteredEntries> {
  const { cfg, opts, now, shouldYield } = params;
  let rowContext: SessionListRowContext | undefined;
  const getRowContext = () => (rowContext ??= params.getRowContext());
  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
  const label = normalizeOptionalString(opts.label) ?? "";
  const boardFace = opts.boardFace;
  const agentId = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  const search = normalizeLowercaseStringOrEmpty(opts.search);
  const activeMinutes =
    typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;
  const creatorId = normalizeOptionalString(opts.creatorId);
  const ownerId = normalizeOptionalString(opts.ownerId);
  const ownerFirstActorId = normalizeOptionalString(params.ownerFirstActorId);
  const activeCutoff = activeMinutes === undefined ? undefined : now - activeMinutes * 60_000;
  const entries: SessionEntryPair[] = [];
  const ownerEntries: SessionEntryPair[] = [];
  const ownerFacet = new Map<string, SessionOwnerFacetIdentity>();
  const people = new Map<string, NonNullable<SessionsListResult["people"]>[number]>();
  let peopleSessionCount = 0;
  let peopleIncomplete = false;
  const configuredAgentIds = params.configuredAgentIds ?? new Set(listAgentIds(cfg));
  const identities =
    params.userProfileIdentityById ?? new Map<string, SessionActorProfileIdentity | undefined>();
  const profileRelation = opts.profileRelation
    ? {
        ...opts.profileRelation,
        profileId: projectSessionParticipant(
          { type: "profile", id: opts.profileRelation.profileId },
          identities,
          cfg,
        ).identity.id,
      }
    : undefined;
  const involvingActorId = normalizeOptionalString(params.involvingActorId);

  // The caller owns these resident entries and their prepared visibility filter.
  const visibleEntries: SessionEntryPair[] = [];
  for (const [key, entry] of params.entries) {
    if (params.entryFilter?.(key, entry) ?? true) {
      visibleEntries.push([key, entry]);
    }
    if (shouldYield?.()) {
      yield;
    }
  }
  const allowedProfileIds =
    opts.involvingProfileId && params.restrictProfileReferences ? new Set<string>() : undefined;
  if (allowedProfileIds) {
    for (const [, entry] of visibleEntries) {
      const owner = projectSessionOwner(entry, identities, cfg, configuredAgentIds)?.actor;
      for (const person of projectSessionPeople(entry, identities, cfg, owner)) {
        allowedProfileIds.add(person.identity.id);
      }
      if (shouldYield?.()) {
        yield;
      }
    }
  }
  const profileReference = opts.involvingProfileId
    ? yield* resolveSessionListProfileReference(
        opts.involvingProfileId,
        visibleEntries,
        identities,
        allowedProfileIds,
        shouldYield,
      )
    : undefined;
  if (profileReference && !profileReference.ok) {
    throw new Error("Person link is ambiguous. Use a longer profile ID in the Activity URL.");
  }
  const selectedProfileId = profileReference?.value;

  const keepCandidate = ([key, entry]: SessionEntryPair) => {
    const target = params.getTarget(key);
    const storeKey = target?.storeKey ?? key;
    if (
      isCronRunSessionKey(key) ||
      (opts.excludeSubagents === true && (isSubagentSessionKey(key) || entry.spawnedBy)) ||
      (!includeGlobal && storeKey === "global") ||
      (!includeUnknown && storeKey === "unknown")
    ) {
      return false;
    }
    if (agentId && storeKey !== "global") {
      const ownerAgentId = target?.storeKey ? target.agentId : parseAgentSessionKey(key)?.agentId;
      if (!ownerAgentId || normalizeAgentId(ownerAgentId) !== agentId) {
        return false;
      }
    }
    if (isPhantomAgentStoreListEntry(key, entry)) {
      return false;
    }
    if (spawnedBy) {
      if (storeKey === "unknown" || storeKey === "global") {
        return false;
      }
      const keepSpawned = resolveSessionChildOwners({
        key,
        entry,
        now,
        subagentRuns: getRowContext().subagentRuns,
      }).includes(spawnedBy);
      if (!keepSpawned) {
        return false;
      }
    }
    if (opts.archived !== "all") {
      const archived = entry.archivedAt !== undefined;
      if (opts.archived === true ? !archived : archived) {
        return false;
      }
    }
    if (
      opts.requireLastInteraction === true &&
      (!isFinitePositiveTimestamp(entry.lastInteractionAt) ||
        normalizeOptionalString(entry.heartbeatIsolatedBaseSessionKey))
    ) {
      return false;
    }
    if ((label && entry.label !== label) || (boardFace && entry.boardFace !== boardFace)) {
      return false;
    }
    if (opts.projectId !== undefined && entry.projectId !== opts.projectId) {
      return false;
    }
    if (
      opts.workspaceDir !== undefined &&
      (entry.spawnedCwd ?? entry.spawnedWorkspaceDir) !== opts.workspaceDir
    ) {
      return false;
    }
    if (opts.group !== undefined && (entry.category ?? "") !== opts.group) {
      return false;
    }
    if (
      opts.pinned !== undefined &&
      (entry.pinnedAt !== undefined && isPinnableSessionEntry(storeKey, entry)) !== opts.pinned
    ) {
      return false;
    }
    return true;
  };
  const candidateEntries: SessionEntryPair[] = [];
  for (const pair of visibleEntries) {
    if (keepCandidate(pair)) {
      candidateEntries.push(pair);
    }
    if (shouldYield?.()) {
      yield;
    }
  }
  // Excluded rows must not participate in search or ownership resolution.
  const matchesSearch = search
    ? createSessionListSearchMatcher({
        cfg,
        search,
        now,
        getTarget: params.getTarget,
        modelCatalog: params.modelCatalog instanceof Map ? params.modelCatalog : undefined,
        getRowContext,
        projectActiveRun: params.projectActiveRun,
      })
    : undefined;

  for (const pair of candidateEntries) {
    if (shouldYield?.()) {
      yield;
    }
    const [key, entry] = pair;
    if (matchesSearch && !matchesSearch(key, entry)) {
      continue;
    }
    if (
      activeCutoff !== undefined &&
      (opts.sortBy === "activity" ? sessionActivityTimestamp(entry) : (entry.updatedAt ?? 0)) <
        activeCutoff
    ) {
      continue;
    }
    const effectiveOwner = projectSessionOwner(entry, identities, cfg, configuredAgentIds)?.actor;
    if (
      profileRelation?.relationship === "owned" &&
      (effectiveOwner?.identity?.type !== "profile" ||
        effectiveOwner.identity.id !== profileRelation.profileId)
    ) {
      continue;
    }
    if (profileRelation?.relationship === "created") {
      const createdProfileId = sessionCreatorProfileId(entry.createdActor);
      if (
        !createdProfileId ||
        projectSessionParticipant({ type: "profile", id: createdProfileId }, identities, cfg)
          .identity.id !== profileRelation.profileId
      ) {
        continue;
      }
    }
    const participants =
      involvingActorId || profileRelation?.relationship === "involving"
        ? projectSessionParticipants(entry, identities, cfg)
        : undefined;
    if (
      profileRelation?.relationship === "involving" &&
      !(
        (effectiveOwner?.identity?.type === "profile" &&
          effectiveOwner.identity.id === profileRelation.profileId) ||
        participants?.has(JSON.stringify({ type: "profile", id: profileRelation.profileId }))
      )
    ) {
      continue;
    }
    if (effectiveOwner) {
      addSessionOwnerFacetIdentity(ownerFacet, effectiveOwner);
    }
    if (creatorId && entry.createdActor?.id !== creatorId) {
      continue;
    }
    if (ownerId && effectiveOwner?.id !== ownerId) {
      continue;
    }
    // Preserve the existing viewer-independent owner facet; explicit relations still narrow it.
    if (
      involvingActorId &&
      !(
        (effectiveOwner?.identity?.type === "profile" &&
          effectiveOwner.identity.id === involvingActorId) ||
        participants?.has(JSON.stringify({ type: "profile", id: involvingActorId }))
      )
    ) {
      continue;
    }
    if (opts.includePeople || opts.involvingProfileId) {
      const associated = projectSessionPeople(entry, identities, cfg, effectiveOwner);
      peopleSessionCount += 1;
      peopleIncomplete ||=
        (entry.participantCount ?? entry.participants?.length ?? 0) >= MAX_SESSION_PARTICIPANTS ||
        entry.participants?.some((participant) => participant.identity.type === "legacy") === true;
      for (const person of associated) {
        const existing = people.get(person.identity.id);
        people.set(person.identity.id, {
          ...person,
          sessionCount: (existing?.sessionCount ?? 0) + 1,
        });
      }
      if (opts.involvingProfileId) {
        if (!associated.some((person) => person.identity.id === selectedProfileId)) {
          continue;
        }
      }
    }
    if (
      effectiveOwner?.identity?.type === "profile" &&
      effectiveOwner.identity.id === ownerFirstActorId
    ) {
      ownerEntries.push(pair);
    }
    entries.push(pair);
  }

  const { people: visiblePeople, overflow } = projectSessionPeopleFacet(
    people.values(),
    selectedProfileId,
  );
  return {
    entries,
    ownerEntries,
    ownerFacet: sortSessionOwnerFacet(ownerFacet),
    // Empty time/search windows do not invalidate a resolved person link.
    involvingProfileId: selectedProfileId,
    ...(opts.includePeople
      ? {
          people: visiblePeople,
          peopleIncomplete: peopleIncomplete || overflow,
          peopleSessionCount,
        }
      : {}),
  };
}

function isPhantomAgentStoreListEntry(key: string, entry: SessionEntry | undefined): boolean {
  return (
    entry?.updatedAt == null &&
    !normalizeOptionalString(entry?.sessionId) &&
    parseAgentSessionKey(key)?.rest === "sessions"
  );
}

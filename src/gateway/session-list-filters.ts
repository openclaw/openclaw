import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type {
  SessionOwnerSessionCount,
  SessionsListParams,
} from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import { buildGroupDisplayName, type SessionEntry } from "../config/sessions.js";
import {
  MAX_SESSION_PARTICIPANTS,
  sessionCreatorProfileId,
} from "../config/sessions/session-entry-provenance.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { formatAgentRuntimeLabel } from "../shared/agent-runtime-display.js";
import { sessionActivityTimestamp } from "../shared/session-activity-timestamp.js";
import { formatGoalSummary } from "../shared/session-goal-display.js";
import { isSessionRunActive } from "../shared/session-run-state.js";
import { normalizeSessionSearchText } from "../shared/session-search-text.js";
import type { SessionActivityPulse, SessionOwnerFacetIdentity } from "../shared/session-types.js";
import type { SynchronousWork } from "../shared/synchronous-work.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.read.js";
import { readPreparedGatewayModelCatalogMetadata } from "./server-model-catalog-view.js";
import {
  projectSessionOwner,
  projectSessionProfileInvolvement,
  addSessionOwnerFacetIdentity,
  sortSessionOwnerFacet,
  projectSessionParticipants,
  projectSessionParticipant,
  projectSessionPeople,
  projectSessionPeopleFacet,
  resolveSessionListProfileReference,
} from "./session-identity-projection.js";
import type { SessionEntryPair } from "./session-list-order.js";
import type {
  SessionListModelFactsLookup,
  SessionListTargetLookup,
} from "./session-list-target.js";
import type {
  SessionActorProfileIdentity,
  SessionListActiveRunProjector,
  SessionListRowContext,
  SessionListRowContextProvider,
} from "./session-utils-contracts.js";
import {
  isFinitePositiveTimestamp,
  matchesSessionArchiveFilter,
  resolveSessionChildOwners,
} from "./session-utils-core.js";
import {
  resolveGatewaySessionDisplayName,
  resolveGatewaySessionKind,
  projectGatewaySessionRunState,
  projectGatewaySessionActiveRun,
  resolveGatewaySessionGoal,
} from "./session-utils-display.js";
import { isGroupOrChannelDisplaySession, parseGroupKey } from "./session-utils-store.js";
import type { SessionListModelCatalog, SessionsListResult } from "./session-utils.types.js";

export type SessionListFilteredEntries = {
  entries: SessionEntryPair[];
  ownerEntries: SessionEntryPair[];
  ownerFacet: SessionOwnerFacetIdentity[];
  ownerSessionCounts?: SessionOwnerSessionCount[];
  people?: SessionsListResult["people"];
  peopleIncomplete?: boolean;
  peopleSessionCount?: number;
  activityExpiresAt?: number;
  activityPulse?: SessionActivityPulse;
  involvingProfileId?: string;
};

export type SessionEntrySelection = Omit<SessionListFilteredEntries, "ownerEntries"> & {
  ownerCount: number;
  totalCount: number;
  limitApplied?: number;
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
};

export type SessionListFilterParams = {
  cfg: OpenClawConfig;
  entries: Iterable<SessionEntryPair>;
  entriesSorted?: boolean;
  getTarget: SessionListTargetLookup;
  getModelFacts?: SessionListModelFactsLookup;
  modelCatalog?: SessionListModelCatalog | ModelCatalogEntry[];
  opts: SessionsListParams;
  now: number;
  userProfileIdentityById?: Map<string, SessionActorProfileIdentity | undefined>;
  configuredAgentIds?: ReadonlySet<string>;
  identityNames?: ReadonlyMap<string, string>;
  getRowContext: SessionListRowContextProvider;
  entryFilter?: (key: string, entry: SessionEntry) => boolean;
  restrictProfileReferences?: boolean;
  involvingActorId?: string;
  ownerFirstActorId?: string;
  projectActiveRun?: SessionListActiveRunProjector;
  shouldYield?: () => boolean;
};

function resolveSessionListSearchDisplayName(
  key: string,
  entry?: SessionEntry,
): string | undefined {
  if (entry?.displayName) {
    return entry.displayName;
  }
  const parsed = parseGroupKey(key);
  const channel = sessionDeliveryChannel(entry) ?? parsed?.channel;
  if (isGroupOrChannelDisplaySession(entry, parsed) && channel) {
    return buildGroupDisplayName({
      provider: channel,
      subject: entry?.subject,
      groupChannel: entry?.groupChannel,
      space: entry?.space,
      id: parsed?.id,
      key,
    });
  }
  return entry?.label ?? sessionDeliveryOrigin(entry)?.label;
}

function addSessionListSearchModelFields(
  fields: Array<string | undefined>,
  identity: { provider?: string; model?: string },
) {
  const provider = normalizeOptionalString(identity.provider);
  const model = normalizeOptionalString(identity.model);
  fields.push(provider, model);
  if (provider && model) {
    fields.push(`${provider}/${model}`);
  }
}

function matchesSessionListSearch(fields: Array<string | undefined>, search: string): boolean {
  return fields.some(
    (field) => typeof field === "string" && normalizeLowercaseStringOrEmpty(field).includes(search),
  );
}

// Selection facts are replaced with the resident entry; weak keys release retired revisions.
const staticSearchFields = new WeakMap<
  NonNullable<ReturnType<SessionListTargetLookup>>["selection"],
  { literal: string[]; titles: string[] }
>();

function createActivityPulse(opts: SessionsListParams): SessionActivityPulse | undefined {
  const boundaries = opts.activityPulseBoundaries;
  if (!boundaries) {
    return undefined;
  }
  return {
    since: boundaries[0]!,
    until: boundaries[boundaries.length - 1]!,
    buckets: Array.from({ length: boundaries.length - 1 }, () => 0),
    sessions: 0,
    ...(opts.activeMinutes === undefined ? {} : { started: 0 }),
    running: 0,
  };
}

export function* filterSessionEntries(
  params: SessionListFilterParams,
): SynchronousWork<SessionListFilteredEntries> {
  const { cfg, opts, now, shouldYield } = params;
  let rowContext: SessionListRowContext | undefined;
  const getRowContext = () => (rowContext ??= params.getRowContext());
  const search = normalizeLowercaseStringOrEmpty(opts.search);
  const activeMinutes =
    typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;
  const creatorId = normalizeOptionalString(opts.creatorId);
  const ownerId = normalizeOptionalString(opts.ownerId);
  const ownerFirstActorId = normalizeOptionalString(params.ownerFirstActorId);
  const activeCutoff = activeMinutes === undefined ? undefined : now - activeMinutes * 60_000;
  let activityExpiresAt = Infinity;
  const entries: SessionEntryPair[] = [];
  const ownerEntries: SessionEntryPair[] = [];
  const ownerFacet = new Map<string, SessionOwnerFacetIdentity>();
  const ownerSessionCounts = opts.includeOwnerSessionCounts
    ? new Map<string, SessionOwnerSessionCount>()
    : undefined;
  const people = new Map<string, NonNullable<SessionsListResult["people"]>[number]>();
  let peopleSessionCount = 0;
  let peopleIncomplete = false;
  const activityPulse = createActivityPulse(opts);
  const pulsePeople = activityPulse && opts.includePeople ? new Set<string>() : undefined;
  const configuredAgentIds = params.configuredAgentIds ?? new Set(listAgentIds(cfg));
  const identities =
    params.userProfileIdentityById ?? new Map<string, SessionActorProfileIdentity | undefined>();
  const identityProjection = getRowContext().identityProjection;
  const projectOwner = identityProjection?.owner ?? projectSessionOwner;
  const projectParticipants = identityProjection?.participants ?? projectSessionParticipants;
  const projectInvolvement = identityProjection?.involvement ?? projectSessionProfileInvolvement;
  const projectPeople = identityProjection?.people ?? projectSessionPeople;
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

  // Person references resolve before candidate filters; ordinary reads need no roster copy.
  const visibleEntries: SessionEntryPair[] = [];
  if (opts.involvingProfileId) {
    for (const pair of params.entries) {
      if (params.entryFilter?.(pair[0], pair[1]) ?? true) {
        visibleEntries.push(pair);
      }
      if (shouldYield?.()) {
        yield;
      }
    }
  }
  const allowedProfileIds =
    opts.involvingProfileId && params.restrictProfileReferences ? new Set<string>() : undefined;
  if (allowedProfileIds) {
    for (const [, entry] of visibleEntries) {
      const owner = projectOwner(entry, identities, cfg, configuredAgentIds)?.actor;
      for (const person of projectPeople(entry, identities, owner)) {
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

  const candidateEntries = opts.involvingProfileId ? visibleEntries : params.entries;
  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
  const label = normalizeOptionalString(opts.label) ?? "";
  const boardFace = opts.boardFace;
  const agentFilter = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  // Excluded rows must not participate in search or ownership resolution.
  const titleSearch = search && normalizeSessionSearchText(search);
  const matchesSearch = search
    ? (key: string, entry: SessionEntry): boolean => {
        const target = expectDefined(params.getTarget(key), "search row owner");
        const storeKey = target.storeKey ?? key;
        let fields = staticSearchFields.get(target.selection);
        if (!fields) {
          const titles = [
            entry.label,
            entry.subject,
            entry.category,
            resolveSessionListSearchDisplayName(storeKey, entry),
            resolveGatewaySessionDisplayName(storeKey, entry),
          ];
          const rawFields = [
            storeKey,
            entry.sessionId,
            ...titles,
            resolveGatewaySessionKind(storeKey, entry),
          ];
          addSessionListSearchModelFields(rawFields, {
            provider: entry.modelProvider,
            model: entry.model,
          });
          fields = {
            literal: rawFields.map(normalizeLowercaseStringOrEmpty),
            titles: titles.map(normalizeSessionSearchText),
          };
          staticSearchFields.set(target.selection, fields);
        }
        if (
          fields.literal.some((field) => field.includes(search)) ||
          (titleSearch && fields.titles.some((field) => field.includes(titleSearch)))
        ) {
          return true;
        }
        const agentId = target.agentId;
        const metadataSnapshot = readPreparedGatewayModelCatalogMetadata(
          params.modelCatalog instanceof Map ? params.modelCatalog.get(agentId) : undefined,
        );
        const run = projectGatewaySessionRunState({
          key: storeKey,
          entry,
          now,
          rowContext: getRowContext(),
        }).fields;
        const active = params.projectActiveRun?.(key, entry, agentId);
        const state = projectGatewaySessionActiveRun(active, run.status);
        const goal = resolveGatewaySessionGoal(entry, now);
        if (
          matchesSessionListSearch(
            [
              state.status,
              isSessionRunActive(state)
                ? "live running"
                : state.hasActiveRun === false
                  ? "idle"
                  : undefined,
              goal
                ? `${goal.objective} ${goal.status} ${formatGoalSummary(goal)} ${goal.lastStatusNote ?? ""}`
                : undefined,
            ],
            search,
          )
        ) {
          return true;
        }
        if (matchesSessionListSearch([params.identityNames?.get(agentId)], search)) {
          return true;
        }
        const source = expectDefined(params.getModelFacts, "prepared search row model facts")(key);
        // Derived model aliases are not agent-key matches.
        if (!search.startsWith("agent:")) {
          const subagentRun = getRowContext().subagentRuns.getDisplaySubagentRun(storeKey);
          const resolvedModel = resolveSessionModelIdentityRef(
            cfg,
            entry,
            agentId,
            subagentRun?.model,
            {
              allowPluginNormalization: false,
              manifestPlugins: metadataSnapshot,
              configuredDefaultModelByAgent: getRowContext().configuredDefaultModelByAgent,
            },
          );
          const models: Array<string | undefined> = [];
          for (const identity of [resolvedModel, source.selectedModel, source.rowModelIdentity]) {
            addSessionListSearchModelFields(models, identity);
          }
          if (matchesSessionListSearch(models, search)) {
            return true;
          }
        }
        return matchesSessionListSearch(
          [formatAgentRuntimeLabel(source.thinkingProjection.agentRuntime)],
          search,
        );
      }
    : undefined;
  const participantKeys = new Map<string, string>();
  const matchesInvolvement = (
    entry: SessionEntry,
    effectiveOwner: NonNullable<ReturnType<typeof projectOwner>>["actor"] | undefined,
    profileId: string,
    personal: boolean,
  ) => {
    const state = projectInvolvement(entry, profileId, identities);
    let participantKey = participantKeys.get(profileId);
    if (!participantKey) {
      participantKey = JSON.stringify({ type: "profile", id: profileId });
      participantKeys.set(profileId, participantKey);
    }
    return (
      !(personal && state?.hidden) &&
      (Boolean(state?.lastMention || (personal && state?.hidden === false)) ||
        (effectiveOwner?.identity?.type === "profile" &&
          effectiveOwner.identity.id === profileId) ||
        projectParticipants(entry, identities, cfg).has(participantKey))
    );
  };

  for (const pair of candidateEntries) {
    if (shouldYield?.()) {
      yield;
    }
    const key = pair[0];
    const entry = pair[1];
    if (!opts.involvingProfileId && params.entryFilter?.(key, entry) === false) {
      continue;
    }
    const target = expectDefined(params.getTarget(key), "selection row owner");
    const { selection } = target;
    const storeKey = target.storeKey ?? key;
    if (
      selection.isCronRun ||
      (opts.excludeCron === true && selection.isCron) ||
      (opts.excludeSystem === true && selection.isSystem) ||
      (opts.excludeDock === true && selection.isDock) ||
      (opts.excludeSubagents === true && selection.isSubagent) ||
      (!includeGlobal && storeKey === "global") ||
      (!includeUnknown && storeKey === "unknown")
    ) {
      continue;
    }
    if (agentFilter && storeKey !== "global") {
      const ownerAgentId = target.storeKey ? normalizeAgentId(target.agentId) : selection.agentId;
      if (ownerAgentId !== agentFilter) {
        continue;
      }
    }
    if (selection.isPhantom) {
      continue;
    }
    if (spawnedBy) {
      if (storeKey === "unknown" || storeKey === "global") {
        continue;
      }
      const keepSpawned = resolveSessionChildOwners({
        key,
        entry,
        now,
        subagentRuns: getRowContext().subagentRuns,
      }).includes(spawnedBy);
      if (!keepSpawned) {
        continue;
      }
    }
    if (!matchesSessionArchiveFilter(entry, opts.archived)) {
      continue;
    }
    if (
      opts.requireLastInteraction === true &&
      (!isFinitePositiveTimestamp(entry.lastInteractionAt) ||
        normalizeOptionalString(entry.heartbeatIsolatedBaseSessionKey))
    ) {
      continue;
    }
    if ((label && entry.label !== label) || (boardFace && entry.boardFace !== boardFace)) {
      continue;
    }
    if (opts.projectId !== undefined && entry.projectId !== opts.projectId) {
      continue;
    }
    if (
      opts.workspaceDir !== undefined &&
      (entry.spawnedCwd ?? entry.spawnedWorkspaceDir) !== opts.workspaceDir
    ) {
      continue;
    }
    if (opts.group !== undefined && (entry.category ?? "") !== opts.group) {
      continue;
    }
    if (
      opts.pinned !== undefined &&
      (entry.pinnedAt !== undefined && isPinnableSessionEntry(storeKey, entry)) !== opts.pinned
    ) {
      continue;
    }
    if (matchesSearch && !matchesSearch(key, entry)) {
      continue;
    }
    if (activeMinutes !== undefined) {
      const activity =
        opts.sortBy === "activity" ? sessionActivityTimestamp(entry) : (entry.updatedAt ?? 0);
      const expiresAt = activity + activeMinutes * 60_000;
      if (expiresAt < now) {
        continue;
      }
      // Facets include candidates absent from the selected person or returned page.
      activityExpiresAt = Math.min(activityExpiresAt, expiresAt);
    }
    const effectiveOwner = projectOwner(entry, identities, cfg, configuredAgentIds)?.actor;
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
    if (
      profileRelation?.relationship === "involving" &&
      !matchesInvolvement(entry, effectiveOwner, profileRelation.profileId, false)
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
    if (involvingActorId && !matchesInvolvement(entry, effectiveOwner, involvingActorId, true)) {
      continue;
    }
    if (opts.includePeople || opts.involvingProfileId) {
      const associated = projectPeople(entry, identities, effectiveOwner);
      peopleSessionCount += 1;
      peopleIncomplete ||=
        (entry.participantCount ?? entry.participants?.length ?? 0) >= MAX_SESSION_PARTICIPANTS ||
        entry.participants?.some((participant) => participant.identity.type === "legacy") === true;
      for (const person of associated) {
        const existing = people.get(person.identity.id);
        if (existing) {
          existing.identity = person.identity;
          existing.label = person.label;
          existing.avatarUrl = person.avatarUrl;
          existing.sessionCount += 1;
        } else {
          // Counts belong to this request, never the cached association.
          people.set(person.identity.id, { ...person, sessionCount: 1 });
        }
      }
      if (opts.involvingProfileId) {
        if (!associated.some((person) => person.identity.id === selectedProfileId)) {
          continue;
        }
      }
      if (pulsePeople) {
        for (const person of associated) {
          pulsePeople.add(person.identity.id);
        }
      }
    }
    if (
      ownerSessionCounts &&
      entry.archivedAt === undefined &&
      effectiveOwner?.identity?.type === "profile"
    ) {
      const profileId = effectiveOwner.identity.id;
      const counts = ownerSessionCounts.get(profileId) ?? { profileId, open: 0, running: 0 };
      const agentId = expectDefined(params.getTarget(key), "counted row owner").agentId;
      const active = params.projectActiveRun?.(key, entry, agentId);
      counts.open += 1;
      counts.running += Number(
        (active?.active === true && active.status !== "queued") ||
          getRowContext().subagentRuns.countActiveDescendantRuns(storeKey) > 0 ||
          getRowContext().projectedSubagentActivity?.has(storeKey) === true,
      );
      ownerSessionCounts.set(profileId, counts);
    }
    if (activityPulse) {
      const agentId = expectDefined(params.getTarget(key), "pulse row owner").agentId;
      activityPulse.sessions += 1;
      activityPulse.running += Number(
        params.projectActiveRun?.(key, entry, agentId)?.active === true,
      );
      if (activityPulse.started !== undefined && activeCutoff !== undefined) {
        activityPulse.started += Number(
          entry.createdAt !== undefined && entry.createdAt >= activeCutoff,
        );
      }
      const activityTs = sessionActivityTimestamp(entry);
      if (activityTs >= activityPulse.since && activityTs < activityPulse.until) {
        const bucket = opts.activityPulseBoundaries!.findLastIndex(
          (boundary) => boundary <= activityTs,
        );
        activityPulse.buckets[bucket] = (activityPulse.buckets[bucket] ?? 0) + 1;
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

  const { people: visiblePeople, overflow } = projectSessionPeopleFacet(people, selectedProfileId);
  if (activityPulse && pulsePeople) {
    activityPulse.people = pulsePeople.size;
  }
  return {
    entries,
    ownerEntries,
    ownerFacet: sortSessionOwnerFacet(ownerFacet),
    ...(ownerSessionCounts
      ? {
          ownerSessionCounts: [...ownerSessionCounts.values()].toSorted((a, b) =>
            a.profileId.localeCompare(b.profileId),
          ),
        }
      : {}),
    // Empty time/search windows do not invalidate a resolved person link.
    involvingProfileId: selectedProfileId,
    ...(Number.isFinite(activityExpiresAt) ? { activityExpiresAt } : {}),
    ...(activityPulse ? { activityPulse } : {}),
    ...(opts.includePeople
      ? {
          people: visiblePeople,
          peopleIncomplete: peopleIncomplete || overflow,
          peopleSessionCount,
        }
      : {}),
  };
}

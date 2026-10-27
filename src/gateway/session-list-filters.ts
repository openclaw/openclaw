import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type {
  SessionOwnerSessionCount,
  SessionsListParams,
} from "../../packages/gateway-protocol/src/index.js";
import { SessionRunStatusSchema } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import { buildGroupDisplayName } from "../config/sessions/group-display.js";
import {
  MAX_SESSION_PARTICIPANTS,
  resolveSessionCreatorActor,
  sessionCreatorProfileId,
} from "../config/sessions/session-entry-provenance.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { formatAgentRuntimeLabel } from "../shared/agent-runtime-display.js";
import { sessionActivityTimestamp } from "../shared/session-activity-timestamp.js";
import { formatGoalSummary } from "../shared/session-goal-display.js";
import { isSessionRunStateActive } from "../shared/session-run-state.js";
import { normalizeSessionSearchText } from "../shared/session-search-text.js";
import type { SessionActivityPulse, SessionOwnerFacetIdentity } from "../shared/session-types.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.read.js";
import { readPreparedGatewayModelCatalogMetadata } from "./server-model-catalog-view.js";
import {
  projectSessionOwner,
  addSessionOwnerFacetIdentity,
  sortSessionOwnerFacet,
  resolveSessionProfileId,
  projectSessionPeople,
  projectSessionPeopleFacet,
  resolveSessionListProfileReference,
} from "./session-identity-projection.js";
import type { SessionEntryPair } from "./session-list-order.js";
import { addSessionListSearchModelFields } from "./session-list-search-fields.js";
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
  totalCount: number;
  ownerFacet: SessionOwnerFacetIdentity[];
  ownerSessionCounts?: SessionOwnerSessionCount[];
  ownerSessionProfiles?: ReadonlyMap<string, string>;
  people?: SessionsListResult["people"];
  peopleIncomplete?: boolean;
  peopleSessionCount?: number;
  activityExpiresAt?: number;
  activityPulse?: SessionActivityPulse;
  involvingProfileId?: string;
};

export type SessionEntrySelection = Omit<SessionListFilteredEntries, "ownerEntries"> & {
  ownerCount: number;
  limitApplied?: number;
  offset: number;
  nextOffset: number | null;
  hasMore: boolean;
};

export type SessionListFilterParams = {
  cfg: OpenClawConfig;
  entries: (archived: SessionsListParams["archived"]) => Iterable<SessionEntryPair>;
  entriesSorted?: boolean;
  getTarget: SessionListTargetLookup;
  getModelFacts?: SessionListModelFactsLookup;
  modelSearchMayMatch?: (search: string) => boolean;
  modelCatalog?: SessionListModelCatalog | ModelCatalogEntry[];
  opts: SessionsListParams;
  now: number;
  userProfileIdentityById?: Map<string, SessionActorProfileIdentity | undefined>;
  configuredAgentIds: ReadonlySet<string>;
  identityNames?: ReadonlyMap<string, string>;
  getRowContext: SessionListRowContextProvider;
  entryFilter?: (
    key: string,
    entry: SessionEntry,
    target: NonNullable<ReturnType<SessionListTargetLookup>>,
  ) => boolean;
  restrictProfileReferences?: boolean;
  involvingActorId?: string;
  ownerFirstActorId?: string;
  projectActiveRun?: SessionListActiveRunProjector;
  involvementKeys: (profileId: string, personal: boolean) => ReadonlySet<string>;
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

function matchesSessionListSearch(fields: Array<string | undefined>, search: string): boolean {
  return fields.some(
    (field) => typeof field === "string" && normalizeLowercaseStringOrEmpty(field).includes(search),
  );
}

// Search follows the committed entry and physical key; weak keys release retired revisions.
const staticSearchFields = new WeakMap<
  SessionEntry,
  { key: string; literal: string[]; titles: string[] }
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

export function filterSessionEntries(
  params: SessionListFilterParams,
  window?: { offset: number; limit?: number; ownerLimit: number },
): SessionListFilteredEntries {
  const { cfg, opts, now, configuredAgentIds } = params;
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
  let totalCount = 0;
  const ownerEntries: SessionEntryPair[] = [];
  const ownerFacet = new Map<string, SessionOwnerFacetIdentity>();
  const ownerSessionCounts = opts.includeOwnerSessionCounts
    ? new Map<string, SessionOwnerSessionCount>()
    : undefined;
  const ownerSessionProfiles = ownerSessionCounts ? new Map<string, string>() : undefined;
  const people = new Map<string, NonNullable<SessionsListResult["people"]>[number]>();
  let peopleSessionCount = 0;
  let peopleIncomplete = false;
  const activityPulse = createActivityPulse(opts);
  const pulsePeople = activityPulse && opts.includePeople ? new Set<string>() : undefined;
  const identities =
    params.userProfileIdentityById ?? new Map<string, SessionActorProfileIdentity | undefined>();
  const identityProjection = getRowContext().identityProjection;
  const projectOwner = identityProjection?.owner ?? projectSessionOwner;
  const projectPeople = identityProjection?.people ?? projectSessionPeople;
  const profileRelation = opts.profileRelation
    ? {
        ...opts.profileRelation,
        profileId: resolveSessionProfileId(opts.profileRelation.profileId, identities),
      }
    : undefined;
  const involvingActorId = normalizeOptionalString(params.involvingActorId);

  // Person references resolve before candidate filters; ordinary reads need no roster copy.
  const visibleEntries: SessionEntryPair[] = [];
  if (opts.involvingProfileId) {
    for (const pair of params.entries("all")) {
      if (
        params.entryFilter?.(
          pair[0],
          pair[1],
          expectDefined(params.getTarget(pair[0]), "selection row owner"),
        ) ??
        true
      ) {
        visibleEntries.push(pair);
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
    }
  }
  const profileReference = opts.involvingProfileId
    ? resolveSessionListProfileReference(
        opts.involvingProfileId,
        visibleEntries,
        identities,
        allowedProfileIds,
      )
    : undefined;
  if (profileReference && !profileReference.ok) {
    throw new Error("Person link is ambiguous. Use a longer profile ID in the Activity URL.");
  }
  const selectedProfileId = profileReference?.value;

  const candidateEntries = opts.involvingProfileId
    ? visibleEntries.filter(([, entry]) => matchesSessionArchiveFilter(entry, opts.archived))
    : params.entries(opts.archived);
  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
  const label = normalizeOptionalString(opts.label) ?? "";
  const boardFace = opts.boardFace;
  const agentFilter = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  // Excluded rows must not participate in search or ownership resolution.
  const titleSearch = search && normalizeSessionSearchText(search);
  const matchesLiteralField = (field: string) => field.includes(search);
  const matchesTitleField = (field: string) => field.includes(titleSearch);
  const searchRunState =
    search &&
    [...SessionRunStatusSchema.anyOf.map((status) => status.const), "live running", "idle"].some(
      (status) => status.includes(search),
    );
  let identityMatches: Map<string, boolean> | undefined;
  let modelMatches: Map<string, boolean> | undefined;
  let runtimeMatches: Map<string, boolean> | undefined;
  let searchModels: boolean | undefined;
  const matchesModelRefs = (
    key: string,
    read: () => Array<Parameters<typeof addSessionListSearchModelFields>[1]>,
  ) => {
    let modelMatch = modelMatches?.get(key);
    if (modelMatch === undefined) {
      const models: Array<string | undefined> = [];
      for (const identity of read()) {
        addSessionListSearchModelFields(models, identity);
      }
      modelMatch = matchesSessionListSearch(models, search);
      (modelMatches ??= new Map()).set(key, modelMatch);
    }
    return modelMatch;
  };
  const matchesSearch = search
    ? (
        key: string,
        entry: SessionEntry,
        target: NonNullable<ReturnType<SessionListTargetLookup>>,
      ): boolean => {
        const storeKey = target.storeKey ?? key;
        let fields = staticSearchFields.get(entry);
        if (!fields || fields.key !== storeKey) {
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
          // Goal search uses entry usage, not elapsed time or display-only timestamps.
          const goal = entry.goal && resolveGatewaySessionGoal(entry, now);
          if (goal) {
            rawFields.push(
              `${goal.objective} ${goal.status} ${formatGoalSummary(goal)} ${goal.lastStatusNote ?? ""}`,
            );
          }
          fields = {
            key: storeKey,
            literal: rawFields.map(normalizeLowercaseStringOrEmpty),
            titles: titles.map(normalizeSessionSearchText),
          };
          staticSearchFields.set(entry, fields);
        }
        if (
          fields.literal.some(matchesLiteralField) ||
          (titleSearch && fields.titles.some(matchesTitleField))
        ) {
          return true;
        }
        const agentId = target.agentId;
        if (searchRunState) {
          const run = projectGatewaySessionRunState({
            key: storeKey,
            entry,
            now,
            rowContext: getRowContext(),
          }).fields;
          const active = params.projectActiveRun?.(key, entry, agentId);
          const state = projectGatewaySessionActiveRun(active, run.status);
          if (
            matchesSessionListSearch(
              [
                state.status,
                isSessionRunStateActive(state)
                  ? "live running"
                  : state.hasActiveRun === false
                    ? "idle"
                    : undefined,
              ],
              search,
            )
          ) {
            return true;
          }
        }
        let identityMatch = identityMatches?.get(agentId);
        if (identityMatch === undefined) {
          identityMatch = matchesSessionListSearch([params.identityNames?.get(agentId)], search);
          (identityMatches ??= new Map()).set(agentId, identityMatch);
        }
        if (identityMatch) {
          return true;
        }
        searchModels ??=
          search.startsWith("agent:") ||
          expectDefined(params.modelSearchMayMatch, "prepared search model vocabulary")(search);
        if (!searchModels) {
          return false;
        }
        // Derived model aliases are not agent-key matches.
        if (!search.startsWith("agent:")) {
          const subagentRun = getRowContext().subagentRuns.getDisplaySubagentRun(storeKey);
          // These are exactly the persisted inputs consumed by the identity resolver.
          const modelKey = JSON.stringify([
            "resolved",
            agentId,
            entry.modelProvider,
            entry.model,
            subagentRun?.model,
            entry.providerOverride,
            entry.modelOverride,
            entry.modelOverrideRouteResolution,
            entry.modelOverrideFallbackOriginProvider,
            entry.modelOverrideFallbackOriginModel,
          ]);
          if (
            matchesModelRefs(modelKey, () => [
              resolveSessionModelIdentityRef(cfg, entry, agentId, subagentRun?.model, {
                allowPluginNormalization: false,
                manifestPlugins: readPreparedGatewayModelCatalogMetadata(
                  params.modelCatalog instanceof Map ? params.modelCatalog.get(agentId) : undefined,
                ),
                configuredDefaultModelByAgent: getRowContext().configuredDefaultModelByAgent,
              }),
            ])
          ) {
            return true;
          }
        }
        const source = expectDefined(params.getModelFacts, "prepared search row model facts")(key);
        if (!search.startsWith("agent:")) {
          const modelKey = JSON.stringify([
            "prepared",
            agentId,
            source.selectedModel.provider,
            source.selectedModel.model,
            source.rowModelIdentity.provider,
            source.rowModelIdentity.model,
          ]);
          if (matchesModelRefs(modelKey, () => [source.selectedModel, source.rowModelIdentity])) {
            return true;
          }
        }
        const runtimeLabel = formatAgentRuntimeLabel(source.thinkingProjection.agentRuntime);
        let runtimeMatch = runtimeMatches?.get(runtimeLabel);
        if (runtimeMatch === undefined) {
          runtimeMatch = matchesSessionListSearch([runtimeLabel], search);
          (runtimeMatches ??= new Map()).set(runtimeLabel, runtimeMatch);
        }
        return runtimeMatch;
      }
    : undefined;
  const personalKeys = involvingActorId && params.involvementKeys(involvingActorId, true);
  const relationKeys =
    profileRelation?.relationship === "involving"
      ? params.involvementKeys(profileRelation.profileId, false)
      : undefined;

  for (const pair of candidateEntries) {
    const key = pair[0];
    const entry = pair[1];
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
    const target = expectDefined(params.getTarget(key), "selection row owner");
    if (!opts.involvingProfileId && params.entryFilter?.(key, entry, target) === false) {
      continue;
    }
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
    if (
      opts.pinned !== undefined &&
      (entry.pinnedAt !== undefined && isPinnableSessionEntry(storeKey, entry)) !== opts.pinned
    ) {
      continue;
    }
    if (matchesSearch && !matchesSearch(key, entry, target)) {
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
        resolveSessionProfileId(createdProfileId, identities) !== profileRelation.profileId
      ) {
        continue;
      }
    }
    if (profileRelation?.relationship === "involving" && !relationKeys?.has(key)) {
      continue;
    }
    if (effectiveOwner) {
      addSessionOwnerFacetIdentity(ownerFacet, effectiveOwner);
    }
    if (creatorId && resolveSessionCreatorActor(entry.createdActor)?.id !== creatorId) {
      continue;
    }
    if (ownerId && effectiveOwner?.id !== ownerId) {
      continue;
    }
    // Preserve the existing viewer-independent owner facet; explicit relations still narrow it.
    if (personalKeys && !personalKeys.has(key)) {
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
      counts.open += 1;
      ownerSessionProfiles!.set(key, profileId);
      ownerSessionCounts.set(profileId, counts);
    }
    if (activityPulse) {
      const agentId = target.agentId;
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
      effectiveOwner.identity.id === ownerFirstActorId &&
      (!window || ownerEntries.length < window.ownerLimit)
    ) {
      ownerEntries.push(pair);
    }
    // Facets and totals cover the full roster; retain only the requested ordered page.
    if (
      !window ||
      (totalCount >= window.offset && (window.limit === undefined || entries.length < window.limit))
    ) {
      entries.push(pair);
    }
    totalCount++;
  }

  const { people: visiblePeople, overflow } = projectSessionPeopleFacet(people, selectedProfileId);
  if (activityPulse && pulsePeople) {
    activityPulse.people = pulsePeople.size;
  }
  return {
    entries,
    ownerEntries,
    totalCount,
    ownerFacet: sortSessionOwnerFacet(ownerFacet),
    ...(ownerSessionCounts
      ? {
          ownerSessionProfiles,
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

/** Open membership is metadata; running state is read from the current runtime owners. */
export function projectSessionOwnerRunningCounts(
  params: SessionListFilterParams,
  selection: SessionEntrySelection,
  candidateKeys: () => Iterable<string>,
): SessionEntrySelection {
  if (!selection.ownerSessionCounts || !selection.ownerSessionProfiles) {
    return selection;
  }
  const counts = new Map(
    selection.ownerSessionCounts.map((count) => [count.profileId, { ...count, running: 0 }]),
  );
  const context = params.getRowContext();
  for (const key of candidateKeys()) {
    const profileId = selection.ownerSessionProfiles.get(key);
    if (profileId === undefined) {
      continue;
    }
    const target = params.getTarget(key);
    if (!target) {
      continue;
    }
    const active = params.projectActiveRun?.(key, target.entry, target.agentId);
    const storeKey = target.storeKey ?? key;
    if (
      (active?.active === true && active.status !== "queued") ||
      context.subagentRuns.countActiveDescendantRuns(storeKey) > 0 ||
      context.projectedSubagentActivity?.has(storeKey) === true
    ) {
      counts.get(profileId)!.running += 1;
    }
  }
  return { ...selection, ownerSessionCounts: [...counts.values()] };
}

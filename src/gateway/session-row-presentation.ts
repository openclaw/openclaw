import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { SESSION_ROWS_DELTA_PREFIX } from "../../packages/gateway-protocol/src/session-row-fields.js";
import { resolveProjectedAgentRunModel } from "../infra/agent-run-registry.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { resolveActiveSessionAgentStatus } from "../sessions/session-agent-status.js";
import { freezeTrustedJsonSnapshot } from "../shared/immutable-data.js";
import { prepareOperatorModelPresentation } from "./operator-model-presentation.js";
import { registerSerializedJsonArray, serializedJsonArrayBytes } from "./serialized-json.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import type { VisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayClient } from "./server-methods/types.js";
import { prepareSessionFastModePresentation } from "./session-fast-mode-presentation.js";
import {
  projectSessionParticipant,
  projectSessionProfileInvolvements,
} from "./session-identity-projection.js";
import { retainSessionListBaseMiss } from "./session-list-diagnostics.js";
import type { SessionEntrySelection, SessionListFilteredEntries } from "./session-list-filters.js";
import type { SessionListView } from "./session-list-view-cache.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import {
  sessionRowId,
  sessionRowsRevision,
  type SessionRowGeneration,
} from "./session-row-identity.js";
import {
  projectPreparedSessionRunState,
  type SessionRowReadView,
} from "./session-row-prepared-read.js";
import type * as records from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import {
  prepareSessionRowPublicationView,
  type PublicationView,
  type SessionRowView,
} from "./session-row-publication.js";
import {
  registerSessionRowEncoding,
  serializeSessionRow,
  sessionRowEncodingBytes,
} from "./session-row-serialization.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionAgentRun,
  resolveSessionVisibility,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { prepareProjectedSessionSharing } from "./session-sharing.js";
import { sessionTitleRequests } from "./session-title-state.js";
import {
  matchesSessionArchiveFilter,
  resolveSessionChildOwners,
  shouldPropagateChildActivity,
} from "./session-utils-core.js";
import {
  applyGatewaySessionRowMode,
  projectGatewaySessionActiveRun,
} from "./session-utils-display.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";

type PresentationOptions = Readonly<
  Omit<records.SnapshotOptions, "now" | "active" | "subagentRuns" | "preparedFacts"> & {
    includeActivitySummary?: boolean;
    rowMode?: SessionsListParams["rowMode"];
    omitSentinelChildren?: boolean;
    childArchiveFilter?: SessionsListParams["archived"];
  }
>;

const DEFAULT_PRESENTATION_OPTIONS: PresentationOptions = {};

function sameFacts(previous: readonly unknown[] | undefined, current: readonly unknown[]) {
  if (previous?.length !== current.length) {
    return false;
  }
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== previous[i]) {
      return false;
    }
  }
  return true;
}

function toProjectedSessionSharingTarget(record: records.MaterializedRow): SessionSharingTarget {
  return {
    agentId: record.agentId,
    canonicalKey: record.key,
    entry: record.entry,
    storeKey: record.key,
    storeKeys: [record.key],
    storePath: record.storeTarget.storePath,
  };
}

/** Immutable row identities own field preparation; fact indexes stay response-local. */
function createSessionRowFactSharing<T extends GatewaySessionRow>() {
  const prepared = new WeakMap<T, { facts: [string, Partial<T>][]; bytes: number }>();
  const share = (sessions: T[]) => {
    // Empty and single-row deltas cannot share facts; keep their prepared wire rows.
    if (sessions.length < 2) {
      return { sessions, sharedFacts: [] };
    }
    type SharedFact = { fact: Partial<T>; rows: number[] };
    const candidates = new Map<string, { fact: Partial<T>; rows: number | number[] }>();
    const rows: GatewaySessionRow[] = [];
    sessions.forEach((row, index) => {
      const { key, kind, updatedAt, sessionId, rowMode } = row;
      rows.push({ key, kind, updatedAt, sessionId, rowMode });
      let facts = prepared.get(row)?.facts;
      if (!facts) {
        facts = [];
        let bytes = 0;
        for (const field in row) {
          const value = row[field];
          // Keep required fields and the projection marker readable without expanding the table.
          if (
            value === undefined ||
            ["key", "kind", "updatedAt", "sessionId", "rowMode"].includes(field)
          ) {
            continue;
          }
          const fact: Partial<T> = {};
          fact[field] = value;
          const encoded = JSON.stringify(fact);
          facts.push([encoded, fact]);
          bytes += encoded.length * 2;
        }
        prepared.set(row, { facts, bytes });
      }
      for (const [encoded, fact] of facts) {
        const candidate = candidates.get(encoded);
        if (candidate) {
          if (typeof candidate.rows === "number") {
            candidate.rows = [candidate.rows, index];
          } else {
            candidate.rows.push(index);
          }
        } else {
          candidates.set(encoded, { fact, rows: index });
        }
      }
    });
    // Facts with the same recipients share one reference, including common scalar defaults.
    const groups = new Map<string, SharedFact>();
    for (const candidate of candidates.values()) {
      if (typeof candidate.rows === "number") {
        Object.assign(rows[candidate.rows]!, candidate.fact);
        continue;
      }
      const key = candidate.rows.join(",");
      const group = groups.get(key);
      if (group) {
        Object.assign(group.fact, candidate.fact);
      } else {
        groups.set(key, { fact: { ...candidate.fact }, rows: candidate.rows });
      }
    }
    const sharedFacts: Partial<T>[] = [];
    for (const group of groups.values()) {
      const reference = sharedFacts.push(group.fact) - 1;
      for (const index of group.rows) {
        (rows[index]!.sharedFacts ??= []).push(reference);
      }
    }
    return { sessions: rows, sharedFacts };
  };
  return {
    share,
    encodingBytes: (row: T) => prepared.get(row)?.bytes ?? 0,
  };
}

const { share: shareSessionRowFacts, encodingBytes: sessionRowFactEncodingBytes } =
  createSessionRowFactSharing<GatewaySessionRow>();
const sharedLists = new WeakMap<
  GatewaySessionRow[],
  ReturnType<typeof shareSessionRowFacts> & { rowsRevision: string }
>();

export function shareSidebarSessionRows(
  rows: GatewaySessionRow[],
  ifRowsRevision?: string,
  rowHistory?: SessionRowGeneration[],
): Pick<
  SessionsListResult,
  "sessions" | "sharedFacts" | "rowsRevision" | "rowsUnchanged" | "rowsDelta"
> {
  let shared = sharedLists.get(rows);
  if (!shared) {
    shared = { ...shareSessionRowFacts(rows), rowsRevision: sessionRowsRevision(rows) };
    registerSerializedJsonArray(shared.sessions, shared.sessions.map(serializeSessionRow));
    sharedLists.set(rows, shared);
  }
  const baseRevision = ifRowsRevision?.startsWith(SESSION_ROWS_DELTA_PREFIX)
    ? ifRowsRevision.slice(SESSION_ROWS_DELTA_PREFIX.length)
    : undefined;
  const revision = baseRevision ?? ifRowsRevision;
  if (revision === shared.rowsRevision) {
    return { sessions: [], rowsRevision: shared.rowsRevision, rowsUnchanged: true };
  }
  const previousGeneration =
    baseRevision === undefined
      ? undefined
      : rowHistory?.find((previous) => previous.revision === baseRevision);
  if (baseRevision !== undefined && previousGeneration) {
    const previous = new Map<number, number>();
    previousGeneration.ids.forEach((id, index) => previous.set(id, index));
    const changed: GatewaySessionRow[] = [];
    const order = rows.map(
      (row) =>
        previous.get(sessionRowId(row)) ?? previousGeneration.ids.length + changed.push(row) - 1,
    );
    if (changed.length < rows.length) {
      const delta = shareSessionRowFacts(changed);
      registerSerializedJsonArray(delta.sessions, delta.sessions.map(serializeSessionRow));
      return {
        ...delta,
        rowsRevision: shared.rowsRevision,
        rowsDelta: { baseRevision, order },
      };
    }
  }
  if (ifRowsRevision !== undefined) {
    // The cached full result is shared by requests with different bases.
    const result = { ...shared };
    retainSessionListBaseMiss(result, previousGeneration ? "all-rows-changed" : "unknown-base");
    return result;
  }
  return shared;
}

/** Sharing decisions remain recipient-local; only their identical presented results are reused. */
export function prepareSessionRowPublication(
  projection: SessionRowProjection,
  now: number,
  read: SessionRowReadView = projection,
) {
  const view = prepareSessionRowPublicationView(projection);
  return (client?: GatewayClient | null, projectRun?: VisibleActiveSessionRunProjector) => {
    const recipient = prepareSessionRowRecipient(read, client, view);
    let presentation: ReturnType<typeof prepareProjectedSessionPresentation> | undefined;
    return {
      getAudienceKey() {
        return JSON.stringify([
          recipient.sharing.getCacheKey(projection.sharingRevision),
          recipient.presentFastMode("ultrafast"),
          recipient.publicationState?.factsRevision,
        ]);
      },
      // Event fanout needs display structures only on an audience miss, after live authority.
      getPresentation() {
        return (presentation ??= prepareProjectedSessionPresentation(
          read,
          client,
          now,
          projectRun,
          recipient,
        ));
      },
    };
  };
}

function prepareSessionRowRecipient(
  projection: SessionRowReadView,
  client?: GatewayClient | null,
  publication?: PublicationView,
) {
  const { cfg, policyConfig, rowContext } = projection.state;
  const presentFastMode = prepareSessionFastModePresentation(client);
  const models =
    client === undefined
      ? undefined
      : prepareOperatorModelPresentation({ cfg, policyConfig, client });
  const publicationState = publication?.();
  const sharing = prepareProjectedSessionSharing({
    cfg: policyConfig,
    client: client ?? null,
    isMember: (value, identityId) =>
      projection
        .readMembership({
          agentId: value.agentId,
          key: value.storeKey,
          storePath: value.storePath,
        })
        ?.has(identityId) ?? false,
  });
  return { cfg, policyConfig, rowContext, presentFastMode, models, publicationState, sharing };
}

/** Recreate after yields: the caller identity and clock belong to one synchronous presentation. */
export function prepareProjectedSessionPresentation(
  projection: SessionRowReadView,
  client?: GatewayClient | null,
  now = Date.now(),
  projectRun?: VisibleActiveSessionRunProjector,
  recipient = prepareSessionRowRecipient(projection, client),
) {
  const { cfg, policyConfig, rowContext, presentFastMode, models, publicationState, sharing } =
    recipient;
  const publicationRows = publicationState?.rows;
  const subagentRuns = rowContext.subagentRuns.atTime(now);
  const preparedRowContext = { ...rowContext, subagentRuns };
  const runState = (
    key: string,
    source: Pick<records.MaterializedRow["materialized"]["source"], "entry" | "parsedKey">,
  ) => projectPreparedSessionRunState(key, source, now, preparedRowContext);
  const active = (
    record: Pick<records.MaterializedRow, "key" | "entry" | "agentId" | "storeTarget">,
  ) =>
    projectRun?.({
      storePath: record.storeTarget.storePath,
      requestedKey: record.key,
      canonicalKey: record.key,
      sessionId: record.entry.sessionId,
      agentId: record.agentId,
      defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, record.key),
    });
  const target = (query: records.Lookup) => {
    const record = projection.describe(query);
    return record ? toProjectedSessionSharingTarget(record) : null;
  };
  const profile = gatewayClientSessionCreator(client ?? null);
  const profiles = rowContext.userProfileIdentityById;
  const profileId = profile
    ? projectSessionParticipant({ type: "profile", id: profile.id }, profiles).identity.id
    : undefined;
  const listView = (opts: SessionsListParams, selection = false): SessionListView => {
    const { source: _source, ifRowsRevision: _ifRowsRevision, ...query } = opts;
    if (selection) {
      delete query.rowMode;
      delete query.includeDerivedTitles;
      delete query.includeLastMessage;
      delete query.includeActivitySummary;
    }
    const key = JSON.stringify([
      client === undefined,
      sharing.getCacheKey(),
      presentFastMode("ultrafast"),
      Object.entries(query).toSorted(([left], [right]) => left.localeCompare(right)),
    ]);
    return publicationState?.lists.get(key) ?? { key, refs: 0, bytes: 0, historyRefs: 0 };
  };
  const viewerFacts: Partial<GatewaySessionRow> = {};
  const viewer = (value: SessionSharingTarget, sharingRole = sharing.roleForTarget(value)) => {
    viewerFacts.visibility = resolveSessionVisibility(value.entry);
    viewerFacts.hiddenFromInvolvingMe =
      profileId && !value.entry.incognito && !isIncognitoSessionKey(value.canonicalKey)
        ? ((rowContext.identityProjection?.involvement ?? projectSessionProfileInvolvements)(
            value.entry,
            profiles,
          ).get(profileId)?.hidden ?? false)
        : undefined;
    viewerFacts.sharingRole = sharingRole;
    viewerFacts.sendDisabledReason =
      authorizeSessionAgentRun(
        { cfg: policyConfig, client: client ?? null, target: value },
        { policy: sharing.policy },
      )?.message ??
      sharing.authorizeTarget(value, sharingRole)?.message ??
      (resolveSendPolicy({ cfg, entry: value.entry, sessionKey: value.canonicalKey }) === "deny"
        ? "send blocked by session policy"
        : null);
    return viewerFacts;
  };
  const projectModels = (row: GatewaySessionRow, view?: SessionRowView) => {
    const projected = models?.session(row) ?? row;
    if (projected === row || !view) {
      return projected;
    }
    const variants = (view.modelRows ??= []);
    for (const existing of variants) {
      if (
        existing.modelProvider === projected.modelProvider &&
        existing.model === projected.model &&
        existing.activeModelProvider === projected.activeModelProvider &&
        existing.activeModel === projected.activeModel &&
        existing.contextBudgetStatus === projected.contextBudgetStatus
      ) {
        return existing;
      }
    }
    const snapshot = Object.freeze(projected);
    variants.push(snapshot);
    return snapshot;
  };
  const optionKeys = new WeakMap<PresentationOptions, string>();
  const optionKey = (options: PresentationOptions) => {
    let key = optionKeys.get(options);
    if (key === undefined) {
      key = JSON.stringify([
        client === undefined,
        presentFastMode("ultrafast"),
        options.includeDerivedTitles,
        options.includeLastMessage,
        options.includeActivitySummary,
        options.rowMode,
        options.omitSentinelChildren,
        options.childArchiveFilter,
      ]);
      optionKeys.set(options, key);
    }
    return key;
  };
  // One synchronous presenter compares many rows; only changed facts become retained snapshots.
  let facts: unknown[] = [];
  let recipientFacts: unknown[] = [];
  const present = (
    record: records.MaterializedRow,
    options: PresentationOptions,
  ): GatewaySessionRow | null => {
    const run = active(record);
    const preparedFacts = record.facts?.present();
    const childOwnerSessionKeys = resolveSessionChildOwners({
      key: record.key,
      entry: record.entry,
      parsedKey: record.materialized.source.parsedKey,
      now,
      subagentRuns,
    });
    let excludedChildKeys = options.excludedChildKeys;
    if (!excludedChildKeys && client !== undefined) {
      let excluded: Set<string> | undefined;
      for (const { key, entry } of record.materialized.source.childLinks ?? []) {
        if (sharing.entryFilter?.(key, entry) === false) {
          (excluded ??= new Set()).add(key);
        }
      }
      excludedChildKeys = excluded;
    }
    const sourceSwarm =
      options.rowMode === "sidebar" || options.rowMode === "dashboard"
        ? undefined
        : record.materialized.row.swarm;
    let excludedSwarmKeys: Set<string> | undefined;
    for (const group of sourceSwarm?.groups ?? []) {
      for (const { sessionKey } of group.children ?? []) {
        if (
          excludedChildKeys?.has(sessionKey) ||
          (client !== undefined &&
            projection
              .selectEntries({ key: sessionKey })
              .some((child) => sharing.entryFilter?.(child.key, child.entry) === false))
        ) {
          (excludedSwarmKeys ??= new Set()).add(sessionKey);
        }
      }
    }
    // Writers replace materialized facts; only live run, placement and clock facts need
    // comparison here. These witnesses never grant disclosure to another recipient.
    let published = publicationRows?.get(record.materialized);
    if (publicationRows) {
      const liveModel = resolveProjectedAgentRunModel({
        agentId: record.agentId,
        sessionId: record.entry.sessionId,
        index: rowContext.projectedAgentRuns,
      });
      const temporal = runState(record.key, record.materialized.source);
      facts.length = 0;
      facts.push(
        record.fallbackModel,
        liveModel?.provider,
        liveModel?.model,
        liveModel === null,
        childOwnerSessionKeys,
        temporal.subagentRun?.model,
        temporal.subagentOwner,
        temporal.fields.status,
        temporal.fields.lastRunError,
        temporal.fields.suppressErrorNotice,
        temporal.fields.subagentRunState,
        temporal.fields.hasActiveSubagentRun,
        temporal.fields.startedAt,
        temporal.fields.endedAt,
        temporal.fields.runtimeMs,
        // Transient owners can cycle without publishing a row; retire the earlier sample.
        run?.active,
        run?.status,
        preparedFacts,
        sessionTitleRequests.get({
          storePath: record.storeTarget.storePath,
          sessionKey: record.key,
          sessionId: record.entry.sessionId,
        }) !== undefined,
        resolveActiveSessionAgentStatus(record.entry.agentStatus, now),
        // Active budgeted goals can stamp budgetLimitedAt from enriched usage at this clock.
        record.entry.goal?.status === "active" && record.entry.goal.tokenBudget !== undefined
          ? now
          : undefined,
        run?.runIds?.length,
      );
      if (run?.runIds) {
        for (const id of run.runIds) {
          facts.push(id);
        }
      }
      for (const child of record.materialized.source.childLinks ?? []) {
        const { key, entry } = child;
        const childActive = runState(key, child).fields.hasActiveSubagentRun;
        facts.push(
          key,
          childActive && shouldPropagateChildActivity(key, entry, record.key),
          resolveSessionChildOwners({
            ...child,
            now,
            subagentRuns,
            hasActiveRun: childActive,
          }).includes(record.key),
        );
      }
      if (!sameFacts(published?.facts, facts)) {
        published = { facts, views: new Map(), target: toProjectedSessionSharingTarget(record) };
        publicationRows.set(record.materialized, published);
        facts = [];
      }
    }
    const views = published?.views;
    const value = published?.target ?? toProjectedSessionSharingTarget(record);
    const recipientView = client === undefined ? undefined : viewer(value);
    const canEnsure =
      client !== undefined && preparedFacts?.activitySummary
        ? !authorizeIncognitoSessionTarget({
            client: client ?? null,
            sessionKey: value.canonicalKey,
            target: value,
          }) && !sharing.authorizeTarget(value, recipientView?.sharingRole)
        : undefined;
    const signature = views && optionKey(options);
    recipientFacts.length = 0;
    recipientFacts.push(
      recipientView?.visibility,
      recipientView?.hiddenFromInvolvingMe,
      recipientView?.sharingRole,
      recipientView?.sendDisabledReason,
      canEnsure,
      excludedChildKeys?.size ?? 0,
      excludedSwarmKeys?.size ?? 0,
    );
    if (excludedChildKeys) {
      for (const key of excludedChildKeys) {
        recipientFacts.push(key);
      }
    }
    if (excludedSwarmKeys) {
      for (const key of excludedSwarmKeys) {
        recipientFacts.push(key);
      }
    }
    const variants = signature === undefined ? undefined : views?.get(signature);
    if (variants) {
      for (const cached of variants) {
        if (sameFacts(cached.facts, recipientFacts)) {
          return projectModels(cached.row, cached);
        }
      }
    }
    const row = projection.present(record, {
      ...options,
      now,
      subagentRuns,
      active: run?.active,
      excludedChildKeys,
      preparedFacts,
    });
    row.childOwnerSessionKeys = [...childOwnerSessionKeys];
    row.fastMode = presentFastMode(row.fastMode);
    row.effectiveFastMode = presentFastMode(row.effectiveFastMode);
    if (sourceSwarm) {
      row.swarm = { ...sourceSwarm, groups: [] };
      for (const group of sourceSwarm.groups) {
        row.swarm.groups.push({
          ...group,
          children: group.children?.filter(({ sessionKey }) => !excludedSwarmKeys?.has(sessionKey)),
        });
      }
    }
    if (run) {
      Object.assign(
        row,
        projectGatewaySessionActiveRun(run, row.status),
        run.runIds === undefined ? {} : { activeRunIds: run.runIds },
      );
    }
    if (options.includeActivitySummary === false) {
      row.activitySummary = undefined;
    }
    if (recipientView) {
      Object.assign(row, recipientView);
      if (row.activitySummary) {
        row.activitySummary = { ...row.activitySummary, canEnsure: canEnsure === true };
      }
    }
    applyGatewaySessionRowMode(row, options.rowMode);
    if (options.omitSentinelChildren) {
      row.childSessions = undefined;
      row.hasActiveSubagentRun = undefined;
    }
    if (
      row.childSessions?.length &&
      options.childArchiveFilter !== undefined &&
      options.childArchiveFilter !== "all"
    ) {
      let excluded: Set<string> | undefined;
      for (const { key: childKey, entry } of record.materialized.source.childLinks ?? []) {
        if (!matchesSessionArchiveFilter(entry, options.childArchiveFilter)) {
          (excluded ??= new Set()).add(childKey);
        }
      }
      if (excluded) {
        row.childSessions = row.childSessions.filter((childKey) => !excluded.has(childKey));
      }
    }
    if (signature !== undefined) {
      // Publish the wire snapshot and its bytes together; mutable source aliases stay private.
      const encoded = JSON.stringify(row);
      const snapshot = freezeTrustedJsonSnapshot(row);
      registerSessionRowEncoding(snapshot, encoded);
      const view = { facts: recipientFacts, row: snapshot };
      if (variants) {
        variants.push(view);
      } else {
        views?.set(signature, [view]);
      }
      recipientFacts = [];
      return projectModels(snapshot, view);
    }
    return projectModels(row);
  };
  return {
    rowContext: preparedRowContext,
    active,
    sharing,
    target,
    present(captured: records.MaterializedRow, options = DEFAULT_PRESENTATION_OPTIONS) {
      const record = projection.describe(
        { agentId: captured.agentId, key: captured.key, storePath: captured.storeTarget.storePath },
        captured,
      );
      return record ? present(record, options) : null;
    },
    select(
      opts: SessionsListParams,
      select: (retained?: WeakMap<object, SessionListFilteredEntries>) => SessionEntrySelection,
    ) {
      // These queries consume clock or transient run facts independently of row publications.
      if (opts.search || opts.spawnedBy || opts.activeOnly || opts.activityPulseBoundaries) {
        return select();
      }
      const view = listView(opts, true);
      if (
        view.selectedAt !== undefined &&
        opts.activeMinutes !== undefined &&
        (now < view.selectedAt || now > (view.activityExpiresAt ?? Infinity))
      ) {
        view.selection = undefined;
        view.partitions = undefined;
      }
      if (!view.selection) {
        const { entries, ownerSessionProfiles, ...facets } = select(
          publicationState?.lists.partitions(view),
        );
        Object.freeze(entries);
        view.selection = Object.freeze({
          ...freezeTrustedJsonSnapshot(facets),
          ownerSessionProfiles,
          entries,
        });
        view.selectedAt = now;
        view.activityExpiresAt = view.selection.activityExpiresAt;
        publicationState?.lists.update(view);
      }
      return view.selection;
    },
    list(rows: GatewaySessionRow[], opts: SessionsListParams) {
      // Current authorization and temporal presentation precede reuse. The retained vector
      // owns bytes only; it never retains a connection or grants permission to a later read.
      const view = listView(opts);
      const conditional =
        view.conditional === true ||
        opts.rowMode === "sidebar" ||
        opts.ifRowsRevision !== undefined;
      const previous = view.rows;
      const unchanged =
        previous?.length === rows.length && rows.every((row, index) => row === previous[index])
          ? previous
          : undefined;
      if (unchanged && (!conditional || view.conditional)) {
        return { sessions: unchanged, rowHistory: view.rowHistory };
      }
      // Promotion reuses the vector without adding a history generation.
      const current = unchanged ?? rows;
      Object.freeze(current);
      let sharedBytes = 0;
      if (conditional) {
        // Prepare before admission so the byte limit includes everything this vector pins.
        const shared = shareSidebarSessionRows(current);
        sharedBytes =
          shared.sessions.reduce((bytes, row) => bytes + sessionRowEncodingBytes(row), 0) +
          serializedJsonArrayBytes(shared.sessions);
      } else {
        registerSerializedJsonArray(current, current.map(serializeSessionRow));
      }
      publicationState?.lists.setRows(
        view,
        current,
        conditional,
        sharedBytes,
        sessionRowFactEncodingBytes,
      );
      return { sessions: current, rowHistory: view.rowHistory };
    },
    snapshot(query: records.Lookup, options = DEFAULT_PRESENTATION_OPTIONS) {
      const record = projection.describe(query);
      return record
        ? { row: present(record, options), record, lifecycleRunId: record.entry.lifecycleRunId }
        : { row: null, record };
    },
    authorizeDescription(query: records.Lookup) {
      return authorizeIncognitoSessionTarget({
        client: client ?? null,
        sessionKey: query.key,
        target: isIncognitoSessionKey(query.key) ? null : target(query),
      });
    },
  };
}

import { randomUUID } from "node:crypto";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import {
  SESSION_DASHBOARD_ROW_FIELDS,
  SESSION_ROW_DETAIL_FIELDS,
  SESSION_ROWS_DELTA_PREFIX,
  SESSION_SIDEBAR_ROW_FIELDS,
} from "../../packages/gateway-protocol/src/session-row-fields.js";
import { resolveProjectedAgentRunModel } from "../infra/agent-run-registry.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { resolveActiveSessionAgentStatus } from "../sessions/session-agent-status.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { prepareOperatorModelPresentation } from "./operator-model-presentation.js";
import { registerSerializedJsonArray } from "./serialized-json.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import type { VisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayClient } from "./server-methods/types.js";
import { prepareSessionFastModePresentation } from "./session-fast-mode-presentation.js";
import {
  projectSessionParticipant,
  projectSessionProfileInvolvements,
} from "./session-identity-projection.js";
import type { SessionEntrySelection } from "./session-list-filters.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import type * as records from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionAgentRun,
  resolveSessionVisibility,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { prepareProjectedSessionSharing } from "./session-sharing.js";
import { matchesSessionArchiveFilter, resolveSessionChildOwners } from "./session-utils-core.js";
import {
  projectGatewaySessionActiveRun,
  projectGatewaySessionRunState,
} from "./session-utils-display.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";

type PresentationOptions = Omit<
  records.SnapshotOptions,
  "now" | "active" | "subagentRuns" | "preparedFacts"
> & {
  includeActivitySummary?: boolean;
  rowMode?: SessionsListParams["rowMode"];
  omitSentinelChildren?: boolean;
  childArchiveFilter?: SessionsListParams["archived"];
};

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

type PublicationRows = WeakMap<
  records.MaterializedRow["materialized"],
  {
    facts: readonly unknown[];
    views: Map<string, Readonly<GatewaySessionRow>>;
    target: SessionSharingTarget;
  }
>;
type Publication = {
  factsRevision: number;
  rows: PublicationRows;
  lists: Map<
    string,
    {
      rows?: GatewaySessionRow[];
      previousRows?: GatewaySessionRow[];
      selection?: SessionEntrySelection;
      selectedAt?: number;
    }
  >;
};
type PublicationView = () => Publication;

const publications = new WeakMap<
  SessionRowProjection,
  {
    revision: object | undefined;
  } & Publication
>();
const encodings = new WeakMap<GatewaySessionRow, string>();
/** Immutable row identities own field preparation; fact indexes stay response-local. */
function createSessionRowFactSharing<T extends GatewaySessionRow>() {
  const prepared = new WeakMap<T, [string, Partial<T>][]>();
  return (sessions: T[]) => {
    type SharedFact = { fact: Partial<T>; rows: number[] };
    const candidates = new Map<string, SharedFact>();
    const rows: GatewaySessionRow[] = [];
    sessions.forEach((row, index) => {
      const { key, kind, updatedAt, sessionId, rowMode } = row;
      rows.push({ key, kind, updatedAt, sessionId, rowMode });
      let facts = prepared.get(row);
      if (!facts) {
        facts = [];
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
          facts.push([JSON.stringify(fact), fact]);
        }
        prepared.set(row, facts);
      }
      for (const [encoded, fact] of facts) {
        const candidate = candidates.get(encoded);
        if (candidate) {
          candidate.rows.push(index);
        } else {
          candidates.set(encoded, { fact, rows: [index] });
        }
      }
    });
    // Facts with the same recipients share one reference, including common scalar defaults.
    const groups = new Map<string, SharedFact>();
    for (const candidate of candidates.values()) {
      if (candidate.rows.length < 2) {
        Object.assign(rows[candidate.rows[0]!]!, candidate.fact);
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
}

const shareSessionRowFacts = createSessionRowFactSharing<GatewaySessionRow>();
const sharedLists = new WeakMap<
  GatewaySessionRow[],
  ReturnType<typeof shareSessionRowFacts> & { rowsRevision: string }
>();

export function shareSidebarSessionRows(
  rows: GatewaySessionRow[],
  ifRowsRevision?: string,
  previousRows?: GatewaySessionRow[],
): Pick<
  SessionsListResult,
  "sessions" | "sharedFacts" | "rowsRevision" | "rowsUnchanged" | "rowsDelta"
> {
  let shared = sharedLists.get(rows);
  if (!shared) {
    shared = { ...shareSessionRowFacts(rows), rowsRevision: randomUUID() };
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
  if (
    baseRevision !== undefined &&
    previousRows &&
    sharedLists.get(previousRows)?.rowsRevision === baseRevision
  ) {
    const previous = new Map(previousRows.map((row, index) => [row, index]));
    const changed: GatewaySessionRow[] = [];
    const order = rows.map(
      (row) => previous.get(row) ?? previousRows.length + changed.push(row) - 1,
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
  return shared;
}

/** Only the immutable presentation is encoded; recipient-specific list wrappers stay private. */
export function serializeSessionRow(row: GatewaySessionRow): string {
  let encoded = encodings.get(row);
  if (encoded === undefined) {
    encoded = JSON.stringify(row);
    encodings.set(row, encoded);
  }
  return encoded;
}

/** Sharing decisions remain recipient-local; only their identical presented results are reused. */
export function prepareSessionRowPublication(
  projection: SessionRowProjection,
  now: number,
  read: SessionRowReadView = projection,
) {
  const view: PublicationView = () => {
    const revision = projection.state.revision;
    let publication = publications.get(projection);
    if (!publication) {
      publication = {
        revision,
        factsRevision: 0,
        rows: new WeakMap(),
        lists: new Map(),
      };
      publications.set(projection, publication);
      const retained = publication;
      projection.onSelectionChange((change) => {
        if (change.kind === "reset") {
          retained.lists.clear();
          return;
        }
        // Unaffected immutable vectors remain comparison witnesses after selection retires.
        retained.revision = undefined;
        for (const list of retained.lists.values()) {
          list.selection = undefined;
        }
      });
      projection.onFactsChange((change) => {
        retained.factsRevision++;
        // Retire wire snapshots even when no reader returns after a publication or disposal.
        for (const list of retained.lists.values()) {
          if (change.kind === "reset") {
            list.previousRows = list.rows = undefined;
          } else if (list.rows?.some((row) => row.key === change.key)) {
            list.previousRows = list.rows[0]?.rowMode === "sidebar" ? list.rows : undefined;
            list.rows = undefined;
          }
        }
      });
    } else if (publication.revision !== revision) {
      if (publication.revision !== undefined) {
        publication.lists.clear();
      }
      publication.revision = revision;
    }
    return publication;
  };
  return (client?: GatewayClient | null, projectRun?: VisibleActiveSessionRunProjector) =>
    prepareProjectedSessionPresentation(read, client, now, projectRun, view);
}

/** Recreate after yields: the caller identity and clock belong to one synchronous presentation. */
export function prepareProjectedSessionPresentation(
  projection: SessionRowReadView,
  client?: GatewayClient | null,
  now = Date.now(),
  projectRun?: VisibleActiveSessionRunProjector,
  publication?: PublicationView,
) {
  const { cfg, policyConfig, rowContext } = projection.state;
  const presentFastMode = prepareSessionFastModePresentation(client);
  const models =
    client === undefined
      ? undefined
      : prepareOperatorModelPresentation({ cfg, policyConfig, client });
  const publicationState = publication?.();
  const publicationRows = publicationState?.rows;
  const subagentRuns = rowContext.subagentRuns.atTime(now);
  const preparedRowContext = { ...rowContext, subagentRuns };
  const runState = (
    key: string,
    {
      entry,
      parsedKey,
    }: Pick<records.MaterializedRow["materialized"]["source"], "entry" | "parsedKey">,
  ) =>
    projectGatewaySessionRunState({ key, entry, parsedKey, now, rowContext: preparedRowContext });
  const active = (key: string, entry: records.MaterializedRow["entry"], agentId: string) =>
    projectRun?.({
      requestedKey: key,
      canonicalKey: key,
      sessionId: entry.sessionId,
      agentId,
      defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, key),
    });
  const target = (query: records.Lookup) => {
    const record = projection.describe(query);
    return record ? toProjectedSessionSharingTarget(record) : null;
  };
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
  const profile = gatewayClientSessionCreator(client ?? null);
  const profiles = rowContext.userProfileIdentityById;
  const profileId = profile
    ? projectSessionParticipant({ type: "profile", id: profile.id }, profiles).identity.id
    : undefined;
  const listView = (opts: SessionsListParams) => {
    const { source: _source, ifRowsRevision: _ifRowsRevision, ...query } = opts;
    const key = JSON.stringify([
      client === undefined,
      sharing.cacheKey,
      presentFastMode("ultrafast"),
      Object.entries(query).toSorted(([left], [right]) => left.localeCompare(right)),
    ]);
    const lists = publicationState?.lists;
    let view = lists?.get(key);
    if (!view) {
      view = {};
      // A revision can receive arbitrary paging/search queries; retain bounded recent views.
      if (lists && lists.size >= 32) {
        lists.delete(lists.keys().next().value!);
      }
      lists?.set(key, view);
    }
    return view;
  };
  const viewer = (value: SessionSharingTarget) => ({
    visibility: resolveSessionVisibility(value.entry),
    ...(profileId && !value.entry.incognito && !isIncognitoSessionKey(value.canonicalKey)
      ? {
          hiddenFromInvolvingMe:
            (rowContext.identityProjection?.involvement ?? projectSessionProfileInvolvements)(
              value.entry,
              profiles,
            ).get(profileId)?.hidden ?? false,
        }
      : {}),
    sharingRole: sharing.roleForTarget(value),
    sendDisabledReason:
      authorizeSessionAgentRun(
        { cfg: policyConfig, client: client ?? null, target: value },
        { policy: sharing.policy },
      )?.message ??
      sharing.authorizeTarget(value)?.message ??
      (resolveSendPolicy({ cfg, entry: value.entry, sessionKey: value.canonicalKey }) === "deny"
        ? "send blocked by session policy"
        : null),
  });
  const projectModels = (
    row: GatewaySessionRow,
    views: Map<string, Readonly<GatewaySessionRow>> | undefined,
    signature: string | undefined,
  ) => {
    const projected = models?.session(row) ?? row;
    if (projected === row || !views || signature === undefined) {
      return projected;
    }
    const modelSignature =
      signature +
      JSON.stringify([
        projected.modelProvider,
        projected.model,
        projected.activeModelProvider,
        projected.activeModel,
        projected.contextBudgetStatus,
      ]);
    const existing = views.get(modelSignature);
    if (existing) {
      return existing;
    }
    const snapshot = Object.freeze(projected);
    views.set(modelSignature, snapshot);
    return snapshot;
  };
  // One synchronous presenter compares many rows; only changed facts become retained snapshots.
  let facts: unknown[] = [];
  const present = (
    record: records.MaterializedRow,
    options: PresentationOptions = {},
  ): GatewaySessionRow | null => {
    const run = active(record.key, record.entry, record.agentId);
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
    // Keep invariant row facts out of each recipient's encoded signature. The publication
    // owns these views; in-place preview/profile/lineage updates retire the whole row's views.
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
        record.profileRevision,
        record.lastMessagePreview,
        record.fallbackModel,
        liveModel?.provider,
        liveModel?.model,
        liveModel === null,
        record.materialized.row.swarm,
        childOwnerSessionKeys,
        temporal.subagentRun?.model,
        temporal.subagentOwner,
        temporal.fields.status,
        temporal.fields.lastRunError,
        temporal.fields.subagentRunState,
        temporal.fields.hasActiveSubagentRun,
        temporal.fields.startedAt,
        temporal.fields.endedAt,
        temporal.fields.runtimeMs,
        // Transient owners can cycle without publishing a row; retire the earlier sample.
        run?.active,
        run?.status,
        JSON.stringify(run?.runIds),
        preparedFacts?.placement || preparedFacts?.placementMove
          ? JSON.stringify(preparedFacts)
          : preparedFacts,
        resolveActiveSessionAgentStatus(record.entry.agentStatus, now),
        // Active budgeted goals can stamp budgetLimitedAt from enriched usage at this clock.
        record.entry.goal?.status === "active" && record.entry.goal.tokenBudget !== undefined
          ? now
          : undefined,
        record.materialized.source.childLinks?.length,
      );
      for (const child of record.materialized.source.childLinks ?? []) {
        const { key, entry, parsedKey } = child;
        const childActive = runState(key, child).fields.hasActiveSubagentRun;
        facts.push(
          key,
          childActive,
          resolveSessionChildOwners({
            key,
            entry,
            parsedKey,
            now,
            subagentRuns,
            hasActiveRun: childActive,
          }).includes(record.key),
        );
      }
      const previous = published?.facts;
      let changed = !previous || previous.length !== facts.length;
      for (let index = 0; !changed && index < facts.length; index++) {
        changed = facts[index] !== previous![index];
      }
      if (changed) {
        published = { facts, views: new Map(), target: toProjectedSessionSharingTarget(record) };
        publicationRows.set(record.materialized, published);
        facts = [];
      }
    }
    const views = published?.views;
    const value = published?.target ?? toProjectedSessionSharingTarget(record);
    const viewerFacts = client === undefined ? undefined : viewer(value);
    const canEnsure =
      client !== undefined && preparedFacts?.activitySummary
        ? !authorizeIncognitoSessionTarget({
            client: client ?? null,
            sessionKey: value.canonicalKey,
            target: value,
          }) && !sharing.authorizeTarget(value)
        : undefined;
    const signature =
      views &&
      JSON.stringify([
        presentFastMode("ultrafast"),
        options.includeDerivedTitles,
        options.includeLastMessage,
        options.includeActivitySummary,
        options.rowMode,
        options.omitSentinelChildren,
        options.childArchiveFilter,
        excludedChildKeys?.size ? [...excludedChildKeys] : undefined,
        excludedSwarmKeys && [...excludedSwarmKeys],
        viewerFacts,
        canEnsure,
      ]);
    const cached = signature === undefined ? undefined : views?.get(signature);
    if (cached) {
      return projectModels(cached, views, signature);
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
    if (viewerFacts) {
      Object.assign(row, viewerFacts);
      if (row.activitySummary) {
        row.activitySummary = { ...row.activitySummary, canEnsure: canEnsure === true };
      }
    }
    if (options.rowMode === "dashboard" || options.rowMode === "sidebar") {
      const fields =
        options.rowMode === "sidebar" ? SESSION_SIDEBAR_ROW_FIELDS : SESSION_DASHBOARD_ROW_FIELDS;
      for (const field of Object.keys(row)) {
        if (!fields.has(field)) {
          Reflect.deleteProperty(row, field);
        }
      }
      row.rowMode = options.rowMode;
    } else if (options.rowMode === "compact") {
      for (const field of SESSION_ROW_DETAIL_FIELDS) {
        delete row[field];
      }
      row.rowMode = "compact";
    }
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
      const snapshot = freezeJsonSnapshot(row);
      encodings.set(snapshot, encoded);
      views?.set(signature, snapshot);
      return projectModels(snapshot, views, signature);
    }
    return projectModels(row, views, signature);
  };
  return {
    get audienceKey() {
      return JSON.stringify([
        sharing.cacheKey,
        presentFastMode("ultrafast"),
        publicationState?.factsRevision,
      ]);
    },
    rowContext: preparedRowContext,
    active,
    sharing,
    target,
    present(captured: records.MaterializedRow, options: PresentationOptions = {}) {
      const record = projection.describe(
        { agentId: captured.agentId, key: captured.key, storePath: captured.storeTarget.storePath },
        captured,
      );
      return record ? present(record, options) : null;
    },
    select(opts: SessionsListParams, select: () => SessionEntrySelection) {
      // These queries consume clock or transient run facts independently of row publications.
      if (opts.search || opts.spawnedBy || opts.activeOnly || opts.activityPulseBoundaries) {
        return select();
      }
      const view = listView(opts);
      if (
        view.selection &&
        opts.activeMinutes !== undefined &&
        (now < view.selectedAt! || now > (view.selection.activityExpiresAt ?? Infinity))
      ) {
        view.selection = undefined;
      }
      if (!view.selection) {
        const { entries, ownerSessionProfiles, ...facets } = select();
        Object.freeze(entries);
        view.selection = Object.freeze({
          ...freezeJsonSnapshot(facets),
          ownerSessionProfiles,
          entries,
        });
        view.selectedAt = now;
      }
      return view.selection;
    },
    list(rows: GatewaySessionRow[], opts: SessionsListParams) {
      // Current authorization and temporal presentation precede reuse. The retained vector
      // owns bytes only; it never retains a connection or grants permission to a later read.
      const view = listView(opts);
      const previous = view.rows;
      if (previous?.length === rows.length && rows.every((row, index) => row === previous[index])) {
        return { sessions: previous, previousRows: view.previousRows };
      }
      Object.freeze(rows);
      // Sidebar replies encode the fact-packed rows in shareSidebarSessionRows.
      if (opts.rowMode !== "sidebar") {
        registerSerializedJsonArray(rows, rows.map(serializeSessionRow));
      } else if (previous) {
        view.previousRows = previous;
      }
      view.rows = rows;
      return { sessions: rows, previousRows: view.previousRows };
    },
    snapshot(query: records.Lookup, options: PresentationOptions = {}) {
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

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
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "./session-request-agent.js";
import {
  sessionRowId,
  sessionRowsRevision,
  type SessionRowGeneration,
} from "./session-row-identity.js";
import {
  projectPreparedSessionRunState,
  toProjectedSessionSharingTarget,
  prepareLinkedSessionEntryFilter,
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
  serializeSessionRow,
  sessionRowEncodingBytes,
  shareSessionRowFacts,
  sessionRowFactEncodingBytes,
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
        // Fixed-domain prefixes keep the opaque sharing key intact without re-encoding it.
        return `${recipient.presentFastMode("ultrafast") === true ? 0 : 1}:${recipient.publicationState?.factsRevision ?? ""}:${recipient.sharing.getCacheKey(projection.sharingRevision)}`;
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
  return { cfg, policyConfig, rowContext, presentFastMode, publicationState, sharing };
}

/** Recreate after yields: the caller identity and clock belong to one synchronous presentation. */
export function prepareProjectedSessionPresentation(
  projection: SessionRowReadView,
  client?: GatewayClient | null,
  now = Date.now(),
  projectRun?: VisibleActiveSessionRunProjector,
  recipient = prepareSessionRowRecipient(projection, client),
) {
  const { cfg, policyConfig, rowContext, presentFastMode, publicationState, sharing } = recipient;
  const entryFilter = client === undefined ? undefined : sharing.entryFilter;
  const models =
    client === undefined
      ? undefined
      : prepareOperatorModelPresentation({ cfg, policyConfig, client });
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
  const canReadLinkedEntry = prepareLinkedSessionEntryFilter(
    projection,
    sharing.entryFilter,
    sharing.identity?.id,
  );
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
      // oxlint-disable-next-line unicorn/no-array-sort -- Object.entries creates a private array.
      Object.entries(query).sort(([left], [right]) => left.localeCompare(right)),
    ]);
    return publicationState?.lists.get(key) ?? { key, refs: 0, bytes: 0, historyRefs: 0 };
  };
  const viewerFacts: Partial<GatewaySessionRow> = {};
  const viewer = (value: SessionSharingTarget, rowMode: PresentationOptions["rowMode"]) => {
    const sharingRole = sharing.roleForTarget(value);
    viewerFacts.visibility = resolveSessionVisibility(value.entry);
    viewerFacts.hiddenFromInvolvingMe =
      profileId && !value.entry.incognito && !isIncognitoSessionKey(value.canonicalKey)
        ? ((rowContext.identityProjection?.involvement ?? projectSessionProfileInvolvements)(
            value.entry,
            profiles,
          ).get(profileId)?.hidden ?? false)
        : undefined;
    viewerFacts.sharingRole = sharingRole;
    // Summary modes omit this diagnostic; their disclosure still uses current sharing facts.
    viewerFacts.sendDisabledReason =
      rowMode === "sidebar" || rowMode === "dashboard"
        ? undefined
        : (authorizeSessionAgentRun(
            { cfg: policyConfig, client: client ?? null, target: value },
            { policy: sharing.policy },
          )?.message ??
          sharing.authorizeTarget(value, sharingRole)?.message ??
          (resolveSendPolicy({ cfg, entry: value.entry, sessionKey: value.canonicalKey }) === "deny"
            ? "send blocked by session policy"
            : null));
    return viewerFacts;
  };
  const projectModels = (row: GatewaySessionRow, view?: SessionRowView) =>
    models?.session(row, view && (view.modelRows ??= [])) ?? row;
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
    if (!excludedChildKeys && entryFilter) {
      let excluded: Set<string> | undefined;
      for (const { key, entry, agentId, storePath } of record.materialized.source.childLinks ??
        []) {
        const owner = agentId ? undefined : resolveRequestedSessionAgentId(cfg, key);
        if (
          !canReadLinkedEntry(
            key,
            entry,
            agentId ?? (owner?.ok ? owner.agentId : undefined),
            storePath,
          )
        ) {
          (excluded ??= new Set()).add(key);
        }
      }
      excludedChildKeys = excluded;
    }
    const fullRow = options.rowMode !== "sidebar" && options.rowMode !== "dashboard";
    const sourceSwarm = fullRow ? record.materialized.row.swarm : undefined;
    let excludedSwarmKeys: Set<string> | undefined;
    for (const group of sourceSwarm?.groups ?? []) {
      for (const { sessionKey } of group.children ?? []) {
        if (
          excludedChildKeys?.has(sessionKey) ||
          (entryFilter &&
            projection
              .selectEntries({ key: sessionKey })
              .some(
                (child) =>
                  !canReadLinkedEntry(
                    child.key,
                    child.entry,
                    child.agentId,
                    child.storeTarget.storePath,
                  ),
              ))
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
      // Overwrite before truncating: clearing length first discards V8's backing storage.
      facts[0] = record.fallbackModel;
      facts[1] = liveModel?.provider;
      facts[2] = liveModel?.model;
      facts[3] = liveModel === null;
      facts[4] = childOwnerSessionKeys;
      facts[5] = temporal.subagentRun?.model;
      facts[6] = temporal.subagentOwner;
      facts[7] = temporal.fields.status;
      facts[8] = temporal.fields.lastRunError;
      facts[9] = temporal.fields.suppressErrorNotice;
      facts[10] = temporal.fields.subagentRunState;
      facts[11] = temporal.fields.hasActiveSubagentRun;
      facts[12] = temporal.fields.startedAt;
      facts[13] = temporal.fields.endedAt;
      facts[14] = temporal.fields.runtimeMs;
      // Transient owners can cycle without publishing a row; retire the earlier sample.
      facts[15] = run?.active;
      facts[16] = run?.status;
      facts[17] = preparedFacts;
      facts[18] =
        sessionTitleRequests.get({
          storePath: record.storeTarget.storePath,
          sessionKey: record.key,
          sessionId: record.entry.sessionId,
        }) !== undefined;
      facts[19] = resolveActiveSessionAgentStatus(record.entry.agentStatus, now);
      // Active budgeted goals can stamp budgetLimitedAt from enriched usage at this clock.
      facts[20] =
        record.entry.goal?.status === "active" && record.entry.goal.tokenBudget !== undefined
          ? now
          : undefined;
      facts[21] = run?.runIds?.length;
      facts.length = 22;
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
    const recipientView = client === undefined ? undefined : viewer(value, options.rowMode);
    const includeActivitySummary = options.includeActivitySummary !== false && fullRow;
    const canEnsure =
      includeActivitySummary && client !== undefined && preparedFacts?.activitySummary
        ? !authorizeIncognitoSessionTarget({
            client: client ?? null,
            sessionKey: value.canonicalKey,
            target: value,
          }) && !sharing.authorizeTarget(value, recipientView?.sharingRole)
        : undefined;
    const signature = views && optionKey(options);
    recipientFacts[0] = recipientView?.visibility;
    recipientFacts[1] = recipientView?.hiddenFromInvolvingMe;
    recipientFacts[2] = recipientView?.sharingRole;
    recipientFacts[3] = recipientView?.sendDisabledReason;
    recipientFacts[4] = canEnsure;
    recipientFacts[5] = excludedChildKeys?.size ?? 0;
    recipientFacts[6] = excludedSwarmKeys?.size ?? 0;
    recipientFacts.length = 7;
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
    if (sourceSwarm && excludedSwarmKeys) {
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
    if (!includeActivitySummary) {
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
      // Shared-fact replies never send this raw row; encode only at the wire boundary.
      const snapshot = freezeTrustedJsonSnapshot(row);
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
      // Membership, clocks, and transient runs are not owned by metadata partitions.
      const live = opts.activeOnly || opts.activityPulseBoundaries;
      if (sharing.sessionCap === "invited" || opts.search || opts.spawnedBy || live) {
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

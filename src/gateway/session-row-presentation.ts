import { SESSION_ROW_DETAIL_FIELDS } from "../../packages/gateway-protocol/src/session-row-fields.js";
import { resolveProjectedAgentRunModel } from "../infra/agent-run-registry.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { resolveActiveSessionAgentStatus } from "../sessions/session-agent-status.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { prepareOperatorModelPresentation } from "./operator-model-presentation.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import type { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayClient } from "./server-methods/types.js";
import { prepareSessionFastModePresentation } from "./session-fast-mode-presentation.js";
import {
  projectSessionParticipant,
  projectSessionProfileInvolvement,
} from "./session-identity-projection.js";
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
import { resolveSessionChildOwners } from "./session-utils-core.js";
import {
  projectGatewaySessionActiveRun,
  projectGatewaySessionRunState,
} from "./session-utils-display.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

type PresentationOptions = Omit<
  records.SnapshotOptions,
  "now" | "active" | "subagentRuns" | "preparedFacts"
> & {
  includeActivitySummary?: boolean;
  rowMode?: "compact";
  omitSentinelChildren?: boolean;
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
  records.MaterializedRow,
  {
    facts: readonly unknown[];
    views: Map<string, Readonly<GatewaySessionRow>>;
    target: SessionSharingTarget;
  }
>;
const publications = new WeakMap<SessionRowProjection, PublicationRows>();
const encodings = new WeakMap<GatewaySessionRow, string>();

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
  let rows = publications.get(projection);
  if (!rows) {
    rows = new WeakMap();
    publications.set(projection, rows);
  }
  return (
    client?: GatewayClient | null,
    projectRun?: ReturnType<typeof createVisibleActiveSessionRunProjector>,
  ) => prepareProjectedSessionPresentation(read, client, now, projectRun, rows);
}

/** Recreate after yields: the caller identity and clock belong to one synchronous presentation. */
export function prepareProjectedSessionPresentation(
  projection: SessionRowReadView,
  client?: GatewayClient | null,
  now = Date.now(),
  projectRun?: ReturnType<typeof createVisibleActiveSessionRunProjector>,
  publicationRows?: PublicationRows,
) {
  const { cfg, policyConfig, rowContext } = projection.state;
  const presentFastMode = prepareSessionFastModePresentation(client);
  const models =
    client === undefined
      ? undefined
      : prepareOperatorModelPresentation({ cfg, policyConfig, client });
  const subagentRuns = rowContext.subagentRuns.atTime(now);
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
  const viewer = (value: SessionSharingTarget) => ({
    visibility: resolveSessionVisibility(value.entry),
    ...(profileId && !value.entry.incognito && !isIncognitoSessionKey(value.canonicalKey)
      ? {
          hiddenFromInvolvingMe:
            projectSessionProfileInvolvement(value.entry, profileId, profiles)?.hidden ?? false,
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
  const present = (
    captured: records.MaterializedRow,
    options: PresentationOptions = {},
  ): GatewaySessionRow | null => {
    const record = projection.describe(
      { agentId: captured.agentId, key: captured.key, storePath: captured.storeTarget.storePath },
      captured,
    );
    if (!record) {
      return null;
    }
    const run = active(record.key, record.entry, record.agentId);
    const preparedFacts = record.facts?.present();
    const childOwnerSessionKeys = resolveSessionChildOwners({
      key: record.key,
      entry: record.entry,
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
    const sourceSwarm = record.materialized.row.swarm;
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
    let published = publicationRows?.get(record);
    if (publicationRows) {
      const liveModel = resolveProjectedAgentRunModel({
        agentId: record.agentId,
        sessionId: record.entry.sessionId,
        index: rowContext.projectedAgentRuns,
      });
      const runState = (key: string, entry: records.MaterializedRow["entry"]) =>
        projectGatewaySessionRunState({
          key,
          entry,
          now,
          rowContext: { ...rowContext, subagentRuns },
        });
      const temporal = runState(record.key, record.entry);
      const facts = [
        record.materialized,
        record.materializedSequence,
        record.profileRevision,
        record.subagentRevision,
        record.lastMessagePreview,
        record.fallbackModel,
        liveModel?.provider,
        liveModel?.model,
        liveModel === null,
        sourceSwarm,
        subagentRuns.revision,
        childOwnerSessionKeys,
        temporal.subagentRun,
        temporal.fields.hasActiveSubagentRun,
        temporal.fields.runtimeMs,
        // Transient owners can cycle without publishing a row; retire the earlier sample.
        JSON.stringify([run, preparedFacts]),
        resolveActiveSessionAgentStatus(record.entry.agentStatus, now),
        // Active budgeted goals can stamp budgetLimitedAt from enriched usage at this clock.
        record.entry.goal?.status === "active" && record.entry.goal.tokenBudget !== undefined
          ? now
          : undefined,
        ...(record.materialized.source.childLinks ?? []).flatMap(({ key, entry }) => {
          const childActive = runState(key, entry).fields.hasActiveSubagentRun;
          return [
            childActive,
            resolveSessionChildOwners({
              key,
              entry,
              now,
              subagentRuns,
              hasActiveRun: childActive,
            }).includes(record.key),
          ];
        }),
      ];
      const previous = published?.facts;
      if (!previous || !facts.every((fact, index) => fact === previous[index])) {
        published = { facts, views: new Map(), target: toProjectedSessionSharingTarget(record) };
        publicationRows.set(record, published);
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
        excludedChildKeys?.size ? [...excludedChildKeys] : undefined,
        excludedSwarmKeys && [...excludedSwarmKeys],
        viewerFacts,
        canEnsure,
      ]);
    const cached = signature === undefined ? undefined : views?.get(signature);
    const projectModels = (row: GatewaySessionRow) => {
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
    if (cached) {
      return projectModels(cached);
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
    if (options.rowMode === "compact") {
      for (const field of SESSION_ROW_DETAIL_FIELDS) {
        delete row[field];
      }
      row.rowMode = "compact";
    }
    if (options.omitSentinelChildren) {
      row.childSessions = undefined;
      row.hasActiveSubagentRun = undefined;
    }
    if (signature !== undefined) {
      const snapshot = freezeJsonSnapshot(structuredClone(row));
      views?.set(signature, snapshot);
      return projectModels(snapshot);
    }
    return projectModels(row);
  };
  return {
    rowContext: { ...rowContext, subagentRuns },
    active,
    sharing,
    target,
    present,
    snapshot(query: records.Lookup, options: PresentationOptions = {}) {
      const record = projection.describe(query);
      return record
        ? { row: present(record, options), lifecycleRunId: record.entry.lifecycleRunId }
        : { row: null };
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

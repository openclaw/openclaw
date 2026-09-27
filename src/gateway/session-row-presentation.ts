import { isIncognitoSessionKey } from "../routing/session-key.js";
import { prepareOperatorModelPresentation } from "./operator-model-presentation.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import type { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayClient } from "./server-methods/types.js";
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
  resolveSessionVisibility,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { prepareProjectedSessionSharing } from "./session-sharing.js";
import { projectGatewaySessionActiveRun } from "./session-utils-display.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

type PresentationOptions = Omit<
  records.SnapshotOptions,
  "now" | "active" | "subagentRuns" | "preparedFacts"
> & {
  includeActivitySummary?: boolean;
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

type PublicationRows = WeakMap<records.MaterializedRow, Map<string, GatewaySessionRow>>;
type PublicationView = (context: SessionRowReadView["state"]["rowContext"]) => {
  rows: PublicationRows;
  subagentRuns: SessionRowReadView["state"]["rowContext"]["subagentRuns"];
};

/** Sharing decisions remain recipient-local; only their identical presented results are reused. */
export function prepareSessionRowPublication(projection: SessionRowProjection, now: number) {
  let context: SessionRowReadView["state"]["rowContext"] | undefined;
  let revision: object | undefined;
  let rows: PublicationRows = new WeakMap();
  let subagentRuns: SessionRowReadView["state"]["rowContext"]["subagentRuns"];
  const view: PublicationView = (current) => {
    const sharingRevision = projection.sharingRevision;
    if (context !== current || revision !== sharingRevision || sharingRevision === undefined) {
      context = current;
      revision = sharingRevision;
      rows = new WeakMap();
      subagentRuns = current.subagentRuns.atTime(now);
    }
    return { rows, subagentRuns };
  };
  return (
    client: GatewayClient,
    projectRun: ReturnType<typeof createVisibleActiveSessionRunProjector>,
  ) => prepareProjectedSessionPresentation(projection, client, now, projectRun, view);
}

/** Recreate after yields: the caller identity and clock belong to one synchronous presentation. */
export function prepareProjectedSessionPresentation(
  projection: SessionRowReadView,
  client?: GatewayClient | null,
  now = Date.now(),
  projectRun?: ReturnType<typeof createVisibleActiveSessionRunProjector>,
  publication?: PublicationView,
) {
  const { cfg, policyConfig, rowContext } = projection.state;
  const models =
    client === undefined
      ? undefined
      : prepareOperatorModelPresentation({ cfg, policyConfig, client });
  const shared = publication?.(rowContext);
  const publicationRows = shared?.rows;
  const subagentRuns = shared?.subagentRuns ?? rowContext.subagentRuns.atTime(now);
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
    const excludedChildKeys =
      options.excludedChildKeys ??
      new Set(
        record.materialized.source.childLinks?.flatMap(({ key, entry }) =>
          client !== undefined && sharing.entryFilter?.(key, entry) === false ? [key] : [],
        ),
      );
    const sourceSwarm = record.materialized.row.swarm;
    const swarm = sourceSwarm && {
      ...sourceSwarm,
      groups: sourceSwarm.groups.map((group) => ({
        ...group,
        children: group.children?.filter(
          ({ sessionKey }) =>
            !excludedChildKeys.has(sessionKey) &&
            (client === undefined ||
              !projection
                .selectEntries({ key: sessionKey })
                .some((child) => sharing.entryFilter?.(child.key, child.entry) === false)),
        ),
      })),
    };
    const value = toProjectedSessionSharingTarget(record);
    const viewerFacts = client === undefined ? undefined : viewer(value);
    // Permission-pending and worker availability can change without a row publication.
    const preparedFacts = record.facts?.present();
    const canEnsure =
      client !== undefined && preparedFacts?.activitySummary
        ? !authorizeIncognitoSessionTarget({
            client: client ?? null,
            sessionKey: value.canonicalKey,
            target: value,
          }) && !sharing.authorizeTarget(value)
        : undefined;
    const signature =
      publicationRows &&
      JSON.stringify([
        options.includeDerivedTitles,
        options.includeLastMessage,
        options.includeActivitySummary,
        [...excludedChildKeys],
        swarm,
        run,
        viewerFacts,
        preparedFacts,
        canEnsure,
        record.materializedSequence,
        record.profileRevision,
        record.subagentRevision,
        record.lastMessagePreview,
        record.fallbackModel,
      ]);
    let views = publicationRows?.get(record);
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
      views.set(modelSignature, projected);
      return projected;
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
    if (swarm) {
      row.swarm = swarm;
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
    if (publicationRows && signature !== undefined) {
      if (!views) {
        views = new Map();
        publicationRows.set(record, views);
      }
      views.set(signature, row);
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

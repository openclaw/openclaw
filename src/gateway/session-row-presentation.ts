import { isIncognitoSessionKey } from "../routing/session-key.js";
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
import {
  authorizeIncognitoSessionTarget,
  resolveSessionVisibility,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { prepareProjectedSessionSharing } from "./session-sharing.js";
import { projectGatewaySessionActiveRun } from "./session-utils-display.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

type PresentationOptions = Omit<records.SnapshotOptions, "now" | "active" | "subagentRuns"> & {
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

/** Recreate after yields: the caller identity and clock belong to one synchronous presentation. */
export function prepareProjectedSessionPresentation(
  projection: SessionRowReadView,
  client?: GatewayClient | null,
  now = Date.now(),
  projectRun?: ReturnType<typeof createVisibleActiveSessionRunProjector>,
) {
  const { cfg, rowContext } = projection.state;
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
    cfg,
    client: client ?? null,
    isMember: (value, identityId) =>
      projection
        .describe({
          agentId: value.agentId,
          key: value.storeKey,
          storePath: value.storePath,
        })
        ?.membership.has(identityId) ?? false,
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
      { ...captured, storePath: captured.storeTarget.storePath },
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
    const row = projection.present(record, {
      ...options,
      now,
      subagentRuns,
      active: run?.active,
      excludedChildKeys,
    });
    if (row.swarm) {
      row.swarm = {
        ...row.swarm,
        groups: row.swarm.groups.map((group) => ({
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
    if (client !== undefined) {
      const value = toProjectedSessionSharingTarget(record);
      Object.assign(row, viewer(value));
      if (row.activitySummary) {
        row.activitySummary = {
          ...row.activitySummary,
          canEnsure:
            !authorizeIncognitoSessionTarget({
              client: client ?? null,
              sessionKey: value.canonicalKey,
              target: value,
            }) && !sharing.authorizeTarget(value),
        };
      }
    }
    return row;
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

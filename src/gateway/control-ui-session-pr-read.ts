import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import type { SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitCheckoutContext } from "../infra/git-read-operations.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { getOrCreateWeakOwnerMap } from "../shared/weak-owner-map.js";
import type { TaskPublicationRead } from "../state/github-publication-task-reads.worker.js";
import { readUserProfileAliasRevision } from "../state/user-profile-events.js";
import { readResidentUserProfileId } from "../state/user-profile-list.js";
import type { ControlUiSessionPullRequests } from "./control-ui-contract.js";
import type { SessionPullRequestReadCredential } from "./control-ui-session-pr-request.js";
import { selectTaskPublicationSessions } from "./control-ui-session-task-prs.js";
import { captureOwnGitHubPullRequestReader } from "./github-publication-inspect-reader.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { hasCurrentGatewayOperatorAccess } from "./operator-access-policy.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import { READ_SCOPE, SESSION_READ_SCOPE } from "./operator-scopes.js";
import { isGatewayClientProfilePending } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { isSessionCreatorProfile } from "./session-creator.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import {
  SessionRowFactsPending,
  withReadySessionRows,
  type SessionRowReadView,
} from "./session-row-prepared-read.js";
import type { EntryRow, MaterializedRow } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { createSessionListEntryFilter, resolveSessionVisibility } from "./session-sharing.js";
import type { GatewaySessionEntryRead } from "./session-utils-store.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";

type SelectedSession = Pick<
  GatewaySessionEntryRead,
  "cfg" | "agentId" | "canonicalKey" | "storePath" | "readSource" | "entry"
>;

const projectedTargets = new WeakMap<
  object,
  Map<MaterializedRow, ControlUiSessionPrTarget | undefined>
>();
const boundProjectedTargets = new WeakMap<
  object,
  Map<MaterializedRow, ControlUiSessionPrTarget | undefined>
>();

export type ControlUiSessionPrTarget = {
  sessionId?: string;
  lifecycleRevision?: string;
  params: { sessionKey: string; agentId: string };
  identity: string;
  branchIdentity?: string;
  taskReceipts?: TaskPublicationRead;
  taskReceiptsOnly?: boolean;
  readSource: { agentId: string; path: string };
  source: string | GitCheckoutContext | null;
  githubHost?: string;
  githubPullRequest?: SessionGitHubPullRequestBinding;
  ownGitHubProfileId?: string;
  ownGitHubIdentity?: string;
  refreshIndex?: boolean;
  assertCurrent?: () => void;
};

export type ControlUiSessionPrReadContext = {
  target: ControlUiSessionPrTarget;
  sourceIdentity: string;
  // Internal consumers can inspect all fetched PRs without expanding the UI.
  projection?: "publication";
  onBranchRead?: (snapshot: ControlUiSessionPullRequests) => void;
  /** Same-source branch-only facts retained by the subscription owner, not a fresh read. */
  branchSnapshot?: ControlUiSessionPullRequests;
  retainReadAuthority?: (
    assertCurrent: () => void,
    credential?: SessionPullRequestReadCredential,
  ) => void;
  assertCurrent: () => void;
};

/** Git facts and cached snapshots belong to the recorded session and workspace source. */
export function resolveControlUiSessionPrTarget(
  selected: SelectedSession,
  preparedRepository: GatewaySessionRow["repository"] | null,
  options: { includeBoundPullRequest?: boolean } = {},
): ControlUiSessionPrTarget | undefined {
  const { cfg, agentId, canonicalKey, storePath, readSource, entry } = selected;
  if (!entry?.sessionId || !storePath || !readSource) {
    return undefined;
  }
  let source: ControlUiSessionPrTarget["source"];
  const githubHost = resolveConfiguredGitHubHost(cfg);
  const binding = options.includeBoundPullRequest ? entry.worktree?.githubPullRequest : undefined;
  if (entry.repositoryWorkspaceId) {
    const repository = preparedRepository;
    const publicRemote = repository ? parseGitHubRemoteUrl(repository.url) : null;
    const remote =
      publicRemote ?? (repository ? parseGitHubRemoteUrl(repository.url, githubHost) : null);
    source =
      remote && repository
        ? { ...remote, ...(!publicRemote ? { host: githubHost } : {}), branch: repository.branch }
        : null;
  } else {
    source = resolveSessionWorkspaceRoots(cfg, agentId, entry).diffCwd ?? null;
  }
  return {
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    params: { sessionKey: canonicalKey, agentId },
    githubHost,
    readSource,
    identity: JSON.stringify([
      agentId,
      canonicalKey,
      storePath,
      readSource?.agentId,
      readSource?.path,
      entry.sessionId,
      entry.lifecycleRevision,
      entry.repositoryWorkspaceId,
      entry.worktree?.id,
      binding,
      source,
      githubHost,
    ]),
    source,
    githubPullRequest: binding,
    refreshIndex: Boolean(entry.worktree && !entry.repositoryWorkspaceId),
  };
}

export function resolveProjectedControlUiSessionPrTarget(
  cfg: OpenClawConfig,
  record: MaterializedRow,
  options: { includeBoundPullRequest?: boolean } = {},
) {
  const { storePath, agentId } = record.storeTarget;
  return resolveControlUiSessionPrTarget(
    {
      cfg,
      agentId: record.agentId,
      canonicalKey: record.key,
      storePath,
      readSource: { agentId, path: storePath },
      entry: record.entry,
    },
    record.materialized.row.repository ?? null,
    options,
  );
}

/** Audience and lineage are part of snapshot identity, never inherited from another viewer. */
function withControlUiTaskPrTarget(
  target: ControlUiSessionPrTarget | undefined,
  projection: SessionRowProjection,
  root: EntryRow,
  getAllows: () => (row: EntryRow) => boolean,
  ownerProfileId?: string,
): ControlUiSessionPrTarget | undefined {
  if (!target || root.entry.incognito || isIncognitoSessionKey(root.key)) {
    return target;
  }
  const select = () => selectTaskPublicationSessions(projection, root, getAllows());
  const sessions = select();
  const taskReceipts = { sessions, ...(ownerProfileId ? { ownerProfileId } : {}) };
  return {
    ...target,
    branchIdentity: target.branchIdentity ?? target.identity,
    taskReceipts,
    identity: JSON.stringify([target.identity, JSON.stringify(taskReceipts)]),
    assertCurrent: () => {
      target.assertCurrent?.();
      const current = select();
      if (
        current.length !== sessions.length ||
        current.some((session, index) => {
          const previous = sessions[index];
          return (
            session !== previous &&
            (session.agentId !== previous?.agentId ||
              session.sessionKey !== previous.sessionKey ||
              session.sessionId !== previous.sessionId ||
              session.lifecycleRevision !== previous.lifecycleRevision)
          );
        })
      ) {
        throw new Error("Task pull-request audience changed");
      }
    },
  };
}

export type ControlUiSessionPrRead = () => Promise<ControlUiSessionPrTarget | undefined>;

/** Background facts use the Gateway's current row owner, never a completed caller's grant. */
export async function prepareControlUiSessionPrServiceTarget(
  getProjection: () => SessionRowProjection | undefined,
  query: { sessionKey: string; agentId: string },
): Promise<ControlUiSessionPrTarget | undefined> {
  const projection = getProjection();
  if (!projection || isIncognitoSessionKey(query.sessionKey)) {
    return undefined;
  }
  const lookup = { key: query.sessionKey, agentId: query.agentId };
  return await withReadySessionRows(
    projection,
    () => [lookup],
    (read) => {
      const record = read.describe(lookup);
      if (
        getProjection() !== projection ||
        !record ||
        record.entry.incognito ||
        resolveSessionVisibility(record.entry) === "draft"
      ) {
        return undefined;
      }
      const target = resolveProjectedControlUiSessionPrTarget(read.state.cfg, record);
      return target
        ? {
            ...target,
            assertCurrent: () => {
              target.assertCurrent?.();
              if (
                getProjection() !== projection ||
                projection.capture(lookup) !== record ||
                !projection.isCurrent(record)
              ) {
                throw new Error("Session pull-request target changed");
              }
            },
          }
        : undefined;
    },
  );
}

/** A watcher may follow a replaced target, but never a replacement person or access grant. */
export function createControlUiSessionPrRead(params: {
  allowOwnImportedPullRequest?: boolean;
  taskReceiptsOnly?: boolean;
  client: GatewayClient;
  sessionKey: string;
  agentId?: string;
  getRuntimeConfig: () => OpenClawConfig;
  getSessionRowProjection: () => SessionRowProjection | undefined;
  isCurrentClient: () => boolean;
}): ControlUiSessionPrRead | undefined {
  const {
    client,
    sessionKey,
    agentId,
    getRuntimeConfig,
    getSessionRowProjection,
    isCurrentClient,
  } = params;
  const actor = resolveGatewayOperatorRoleActor(client);
  const actorKind = actor?.kind;
  const actorProfile = actor?.kind === "operator" ? actor.profileId : undefined;
  const profileInput = client.authenticatedUserProfile?.profileId;
  const userInput = client.authenticatedUserId;
  const scopes = [...(client.connect.scopes ?? [])].toSorted().join("\0");
  const access = client.internal?.operatorAccessAuthority;
  const connectionSignal = client.connectionSignal;
  const projection = getSessionRowProjection();
  if (!projection) {
    return undefined;
  }
  let aliasRevision = -1;
  let retained: ControlUiSessionPrTarget | undefined;
  let retainedRevision: object | undefined;
  const captureCurrent = () => {
    try {
      const currentActor = resolveGatewayOperatorRoleActor(client);
      if (
        !isCurrentClient() ||
        client.invalidated ||
        (client.connect.role ?? "operator") !== "operator" ||
        client.connectionSignal !== connectionSignal ||
        connectionSignal?.aborted ||
        isGatewayClientProfilePending(client) ||
        client.authenticatedUserProfile?.profileId !== profileInput ||
        client.authenticatedUserId !== userInput ||
        currentActor?.kind !== actorKind ||
        (currentActor?.kind === "operator" ? currentActor.profileId : undefined) !== actorProfile ||
        [...(client.connect.scopes ?? [])].toSorted().join("\0") !== scopes ||
        client.internal?.operatorAccessAuthority !== access ||
        !hasCurrentGatewayOperatorAccess(access)
      ) {
        return undefined;
      }
      const currentAliasRevision = readUserProfileAliasRevision();
      if (currentAliasRevision !== aliasRevision) {
        if (actorProfile && readResidentUserProfileId(actorProfile) !== actorProfile) {
          return undefined;
        }
        aliasRevision = currentAliasRevision;
      }
      const cfg = getRuntimeConfig();
      if (
        authorizeCurrentOperatorRoleScopes(client, cfg) ||
        !roleScopesAllow({
          role: "operator",
          requestedScopes: [params.allowOwnImportedPullRequest ? SESSION_READ_SCOPE : READ_SCOPE],
          allowedScopes: client.connect.scopes ?? [],
        })
      ) {
        return undefined;
      }
      const requested = resolveRequestedSessionAgentId(cfg, sessionKey, agentId);
      if (!requested.ok) {
        return undefined;
      }
      if (getSessionRowProjection() !== projection) {
        return undefined;
      }
      const query = { key: sessionKey, agentId: requested.agentId };
      const selected = projection.capture(query);
      // Exact reads prepare this session; unrelated pending membership must not hide it.
      if (
        !selected?.entry ||
        !projection.isCurrent(selected) ||
        (isIncognitoSessionKey(selected.key)
          ? projection.needsMembershipPreparation()
          : projection.sharingTargetState(query).status !== "ready") ||
        createSessionListEntryFilter({ cfg, client })?.(selected.key, selected.entry) === false
      ) {
        return undefined;
      }
      return { cfg, query, selected };
    } catch {
      return undefined;
    }
  };
  const readPreparedCurrent = (
    read: SessionRowReadView,
    captured: NonNullable<ReturnType<typeof captureCurrent>>,
  ) => {
    try {
      // Authorize transient private rows before preparing presentation; resident rows reuse it.
      const current = read.describe(captured.query, captured.selected);
      const storePath = current?.storeTarget.storePath;
      if (!current || !storePath) {
        return undefined;
      }
      const repository = current.materialized.row.repository ?? null;
      const revision = projection.sharingRevision;
      const targets =
        revision && !isIncognitoSessionKey(current.key)
          ? getOrCreateWeakOwnerMap(
              params.allowOwnImportedPullRequest ? boundProjectedTargets : projectedTargets,
              revision,
            )
          : undefined;
      let projectedTarget = targets?.get(current);
      if (!targets?.has(current)) {
        projectedTarget = resolveProjectedControlUiSessionPrTarget(captured.cfg, current, {
          includeBoundPullRequest: params.allowOwnImportedPullRequest,
        });
        targets?.set(current, projectedTarget);
      }
      if (!projectedTarget) {
        return undefined;
      }
      const sessionOnly = !roleScopesAllow({
        role: "operator",
        requestedScopes: [READ_SCOPE],
        allowedScopes: client.connect.scopes ?? [],
      });
      if (sessionOnly) {
        if (
          !actorProfile ||
          !projectedTarget.githubPullRequest?.preparedHeadCommit ||
          !isSessionCreatorProfile(current.entry.createdActor, actorProfile)
        ) {
          return undefined;
        }
        const ownReader = captureOwnGitHubPullRequestReader(actorProfile, () =>
          resolveConfiguredGitHubHost(getRuntimeConfig()),
        );
        const identity = JSON.stringify([projectedTarget.identity, ownReader.identity]);
        return {
          target: {
            ...projectedTarget,
            ownGitHubProfileId: actorProfile,
            ownGitHubIdentity: ownReader.identity,
            identity,
            branchIdentity: identity,
            assertCurrent: ownReader.assertCurrent,
          },
          repository,
          projectedIdentity: projectedTarget.identity,
        };
      }
      const target = withControlUiTaskPrTarget(
        projectedTarget,
        projection,
        current,
        () => {
          const filter = createSessionListEntryFilter({ cfg: getRuntimeConfig(), client });
          return (row) => filter?.(row.key, row.entry) !== false;
        },
        actorProfile,
      );
      return target
        ? { target, repository, projectedIdentity: projectedTarget.identity }
        : undefined;
    } catch (error) {
      if (error instanceof SessionRowFactsPending) {
        throw error;
      }
      return undefined;
    }
  };
  return async () => {
    try {
      if (getSessionRowProjection() !== projection) {
        return undefined;
      }
      // Preparation belongs to the row revision; connection and audience authority stay live.
      if (retained) {
        try {
          void projection.state;
          if (retainedRevision === projection.sharingRevision) {
            retained.assertCurrent?.();
            return retained;
          }
        } catch {
          retained = undefined;
        }
      }
      const target = await withReadySessionRows(
        projection,
        (cfg) => {
          const requested = resolveRequestedSessionAgentId(cfg, sessionKey, agentId);
          return requested.ok ? [{ key: sessionKey, agentId: requested.agentId }] : [];
        },
        (read) => {
          const captured = captureCurrent();
          if (!captured) {
            return undefined;
          }
          const prepared = readPreparedCurrent(read, captured);
          if (!prepared) {
            return undefined;
          }
          const privateRow = isIncognitoSessionKey(captured.selected.key);
          const rowContext = projection.readPreparedRowContext();
          if (privateRow && captured.selected.entry?.repositoryWorkspaceId && !rowContext) {
            return undefined;
          }
          return {
            ...prepared,
            revision: projection.sharingRevision,
            captured: privateRow ? undefined : captured.selected,
            privateSource: privateRow
              ? {
                  generation: captured.selected.generation,
                  sessionId: captured.selected.entry?.sessionId,
                  lifecycleRevision: captured.selected.entry?.lifecycleRevision,
                  rowContext,
                }
              : undefined,
          };
        },
      );
      const result = target
        ? {
            ...target.target,
            ...(params.taskReceiptsOnly
              ? {
                  taskReceiptsOnly: true,
                  identity: JSON.stringify([target.target.identity, "receipts-only"]),
                }
              : {}),
            assertCurrent: () => {
              const current = captureCurrent();
              const original = target.privateSource;
              let refreshedRow: MaterializedRow | undefined;
              if (!current) {
                throw new Error("Session pull-request target changed");
              }
              if (!original && current.selected !== target.captured) {
                // Enrichment can replace a row without changing its incarnation or PR source.
                if (current.selected.generation !== target.captured?.generation) {
                  throw new Error("Session pull-request target changed");
                }
                const row = projection.describe(current.query, current.selected);
                if (
                  !row ||
                  resolveProjectedControlUiSessionPrTarget(current.cfg, row, {
                    includeBoundPullRequest: params.allowOwnImportedPullRequest,
                  })?.identity !== target.projectedIdentity
                ) {
                  throw new Error("Session pull-request target changed");
                }
                refreshedRow = row;
              }
              target.target.assertCurrent?.();
              if (!original) {
                if (refreshedRow) {
                  target.captured = refreshedRow;
                }
                return;
              }
              // Private acquisition creates a new Row; retain only its native incarnation and facts.
              const { selected } = current;
              if (
                selected.generation !== original.generation ||
                selected.entry?.sessionId !== original.sessionId ||
                selected.entry?.lifecycleRevision !== original.lifecycleRevision ||
                (selected.entry?.repositoryWorkspaceId &&
                  (!original.rowContext ||
                    projection.readPreparedRowContext() !== original.rowContext)) ||
                resolveControlUiSessionPrTarget(
                  {
                    cfg: current.cfg,
                    agentId: selected.agentId,
                    canonicalKey: selected.key,
                    storePath: selected.storeTarget.storePath,
                    readSource: {
                      agentId: selected.storeTarget.agentId,
                      path: selected.storeTarget.storePath,
                    },
                    entry: selected.entry,
                  },
                  target.repository,
                  { includeBoundPullRequest: params.allowOwnImportedPullRequest },
                )?.identity !== target.target.identity
              ) {
                throw new Error("Session pull-request target changed");
              }
            },
          }
        : undefined;
      retained = target?.privateSource ? undefined : result;
      retainedRevision = target?.revision;
      return result;
    } catch {
      return undefined;
    }
  };
}

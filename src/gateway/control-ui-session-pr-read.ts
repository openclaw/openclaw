import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import { getRuntimeConfigSnapshotMetadata } from "../config/runtime-snapshot.js";
import type { SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitCheckoutContext } from "../infra/git-read-operations.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { getOrCreateWeakOwnerMap } from "../shared/weak-owner-map.js";
import { captureAgentDatabaseAdmission } from "../state/agent-database-admission.js";
import type { TaskPublicationRead } from "../state/github-publication-task-reads.worker.js";
import {
  readUserProfileAliasRevision,
  readUserProfileVersion,
} from "../state/user-profile-events.js";
import { readResidentUserProfileId } from "../state/user-profile-list.js";
import type { ControlUiSessionPullRequests } from "./control-ui-contract.js";
import type { SessionPullRequestReadCredential } from "./control-ui-session-pr-request.js";
import { prepareTaskPublicationSessions } from "./control-ui-session-task-prs.js";
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
import { isSessionCreatorProfile, prepareSessionCreatorProfile } from "./session-creator.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import {
  SessionRowFactsPending,
  withReadySessionRows,
  type SessionRowReadView,
} from "./session-row-prepared-read.js";
import {
  hasEntry,
  isPreparedSessionRowDatabaseFacts,
  type EntryRow,
  type MaterializedRow,
} from "./session-row-projection-record.js";
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
  getAllows: Parameters<typeof prepareTaskPublicationSessions>[2],
  ownerProfileId?: string,
): ControlUiSessionPrTarget | undefined {
  if (!target || root.entry.incognito || isIncognitoSessionKey(root.key)) {
    return target;
  }
  const selected = {
    agentId: root.agentId,
    key: root.key,
    storeTarget: root.storeTarget,
    generation: root.generation,
    entry: { sessionId: root.entry.sessionId, lifecycleRevision: root.entry.lifecycleRevision },
  };
  const selection = prepareTaskPublicationSessions(projection, selected, getAllows);
  const sessions = selection.sessions;
  const taskReceipts = { sessions, ...(ownerProfileId ? { ownerProfileId } : {}) };
  return {
    ...target,
    branchIdentity: target.branchIdentity ?? target.identity,
    taskReceipts,
    identity: JSON.stringify([target.identity, JSON.stringify(taskReceipts)]),
    assertCurrent: () => {
      target.assertCurrent?.();
      selection.assertCurrent();
    },
  };
}

export type ControlUiSessionPrRead = () => Promise<ControlUiSessionPrTarget | undefined>;

/** Passive sidebar audiences share a receipt-only cell beside the full session target. */
export const receiptsOnlyTargetIdentity = (identity: string) =>
  JSON.stringify([identity, "receipts-only"]);

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
  const scopes = [...(client.connect.scopes ?? [])];
  const scopeKey = scopes.toSorted().join("\0");
  const hasCurrentScopes = () => {
    const current = client.connect.scopes;
    if ((current?.length ?? 0) !== scopes.length) {
      return false;
    }
    for (let index = 0; index < scopes.length; index++) {
      if (current![index] !== scopes[index]) {
        // Reordering preserves the grant, including duplicate multiplicity.
        return current!.toSorted().join("\0") === scopeKey;
      }
    }
    return true;
  };
  const access = client.internal?.operatorAccessAuthority;
  const connectionSignal = client.connectionSignal;
  const projection = getSessionRowProjection();
  if (!projection) {
    return undefined;
  }
  let aliasRevision = -1;
  let retained: ControlUiSessionPrTarget | undefined;
  let capture:
    | {
        cfg: OpenClawConfig;
        query: { key: string; agentId: string };
        selected: EntryRow;
        sharing: object | undefined;
        configRevision: ReturnType<typeof getRuntimeConfigSnapshotMetadata>;
        profileVersion: number;
        profile: GatewayClient["preparedSessionProfile"];
        assertAgentAdmitted: () => void;
      }
    | undefined;
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
        !hasCurrentScopes() ||
        client.internal?.operatorAccessAuthority !== access ||
        !hasCurrentGatewayOperatorAccess(access)
      ) {
        return undefined;
      }
      const currentAliasRevision = readUserProfileAliasRevision();
      if (currentAliasRevision !== aliasRevision) {
        capture = undefined;
        if (actorProfile && readResidentUserProfileId(actorProfile) !== actorProfile) {
          return undefined;
        }
        aliasRevision = currentAliasRevision;
      }
      const cfg = getRuntimeConfig();
      if (getSessionRowProjection() !== projection) {
        return undefined;
      }
      // Prepare deferred lineage before consulting the row owner's publication identities.
      void projection.state;
      const sharing = projection.sharingRevision;
      const configRevision = getRuntimeConfigSnapshotMetadata();
      const profileVersion = readUserProfileVersion();
      if (
        capture &&
        sharing &&
        capture.sharing === sharing &&
        capture.cfg === cfg &&
        capture.configRevision === configRevision &&
        capture.profileVersion === profileVersion &&
        capture.profile === client.preparedSessionProfile &&
        !client.internal?.operatorRunAuthority &&
        (!cfg.gateway?.roles ||
          actorKind === "system" ||
          (actorProfile && client.preparedSessionProfile?.aliases.has(actorProfile)))
      ) {
        // Prepared role facts are replaced by their owner. Opaque run/unprepared role
        // authorities keep their live path; admission and plugin access always stay live.
        capture.assertAgentAdmitted();
        return capture;
      }
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
      const query = { key: sessionKey, agentId: requested.agentId };
      const selected = projection.capture(query);
      // Exact reads prepare this session; unrelated pending membership must not hide it.
      if (
        !hasEntry(selected) ||
        !projection.isCurrent(selected) ||
        (isIncognitoSessionKey(selected.key)
          ? projection.needsMembershipPreparation()
          : projection.sharingTargetState(query).status !== "ready") ||
        createSessionListEntryFilter({
          cfg,
          client,
          // Private rows retain their prepared memory authority, outside resident membership.
          membership: isIncognitoSessionKey(selected.key)
            ? undefined
            : projection.readMembership({
                ...query,
                storePath: selected.storeTarget.storePath,
              }),
        })?.(selected.key, selected.entry) === false
      ) {
        return undefined;
      }
      const current = {
        cfg,
        query,
        selected,
        sharing,
        configRevision,
        profileVersion,
        profile: client.preparedSessionProfile,
        assertAgentAdmitted: captureAgentDatabaseAdmission(requested.agentId),
      };
      capture = isIncognitoSessionKey(selected.key) ? undefined : current;
      return current;
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
          const cfg = getRuntimeConfig();
          const isCreator = prepareSessionCreatorProfile(profileInput ?? actorProfile);
          return (row) =>
            createSessionListEntryFilter(
              {
                cfg,
                client,
                membership: projection.readMembership({
                  key: row.key,
                  agentId: row.agentId,
                  storePath: row.storeTarget.storePath,
                }),
              },
              isCreator,
            )?.(row.key, row.entry) !== false;
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
      // The retained target already checks its source and live audience at every read.
      if (retained) {
        try {
          retained.assertCurrent?.();
          return retained;
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
            cfg: captured.cfg,
            taskRevision: projection.readTaskPublicationRevision(),
            factsRevision: captured.selected.databaseFactsRevision,
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
      let validated: NonNullable<ReturnType<typeof captureCurrent>> | undefined;
      const result = target
        ? {
            ...target.target,
            ...(params.taskReceiptsOnly
              ? {
                  taskReceiptsOnly: true,
                  identity: receiptsOnlyTargetIdentity(target.target.identity),
                }
              : {}),
            assertCurrent: () => {
              const current = captureCurrent();
              const original = target.privateSource;
              let refreshedRow: MaterializedRow | undefined;
              if (!current) {
                throw new Error("Session pull-request target changed");
              }
              if (
                current === validated &&
                !original &&
                !target.target.ownGitHubProfileId &&
                current.selected.databaseFactsRevision === target.factsRevision &&
                (current.selected.materialized?.row.repository ?? null) === target.repository &&
                projection.readTaskPublicationRevision() === target.taskRevision
              ) {
                return;
              }
              if (
                !original &&
                (current.selected !== target.captured ||
                  current.selected.databaseFactsRevision !== target.factsRevision ||
                  current.cfg !== target.cfg ||
                  (current.selected.materialized?.row.repository ?? null) !== target.repository)
              ) {
                // Enrichment can replace a row without changing its incarnation or PR source.
                if (current.selected.generation !== target.captured?.generation) {
                  throw new Error("Session pull-request target changed");
                }
                if (!isPreparedSessionRowDatabaseFacts(current.selected.retainedDatabaseFacts)) {
                  throw new SessionRowFactsPending([current.query]);
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
              validated = current;
              if (!original) {
                // Lineage changes revalidate the audience without rebuilding the root's source.
                target.taskRevision = projection.readTaskPublicationRevision();
                if (refreshedRow) {
                  target.captured = refreshedRow;
                  target.factsRevision = refreshedRow.databaseFactsRevision;
                  target.cfg = current.cfg;
                  target.repository = refreshedRow.materialized.row.repository ?? null;
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
      retained = target?.privateSource || target?.target.ownGitHubProfileId ? undefined : result;
      return result;
    } catch {
      return undefined;
    }
  };
}

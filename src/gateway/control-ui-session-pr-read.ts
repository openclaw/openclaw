import { isDeepStrictEqual } from "node:util";
import { getRuntimeConfigSnapshotMetadata } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { captureAgentDatabaseAdmission } from "../state/agent-database-admission.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  readUserProfileAliasRevision,
  readUserProfileVersion,
} from "../state/user-profile-events.js";
import { readResidentUserProfileId } from "../state/user-profile-list.js";
import {
  observeSelectedRepositorySession,
  prepareSelectedRepositorySessionRead,
} from "./control-ui-session-pr-source.js";
import type { createRepositoryTaskPublicationReader } from "./control-ui-session-task-prs.js";
import { withRepositoryTaskAudience } from "./control-ui-session-task-prs.js";
import { captureOwnGitHubPullRequestReader } from "./github-publication-inspect-reader.js";
import { resolveConfiguredGitHubHost } from "./native-github-host-realm.js";
import { hasCurrentGatewayOperatorAccess } from "./operator-access-policy.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import { READ_SCOPE, SESSION_READ_SCOPE } from "./operator-scopes.js";
import type { PreparedRepositorySessionRead } from "./repository-session-read.types.js";
import { isGatewayClientProfilePending } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { isSessionCreatorProfile, prepareSessionCreatorProfile } from "./session-creator.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { withReadySessionRows, SessionRowFactsPending } from "./session-row-prepared-read.js";
import {
  hasEntry,
  isPreparedSessionRowDatabaseFacts,
  type EntryRow,
} from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { createSessionListEntryFilter } from "./session-sharing.js";
import { retainGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";

/** Retain the existing viewer access policy; never derive authority from cached observations. */
export function createRepositoryViewerRead(params: {
  allowOwnImportedPullRequest?: boolean;
  client: GatewayClient;
  sessionKey: string;
  agentId?: string;
  getRuntimeConfig: () => OpenClawConfig;
  getSessionRowProjection: () => SessionRowProjection | undefined;
  isCurrentClient: () => boolean;
  lifetime: AbortSignal;
  runSource: <T>(run: () => Promise<T>) => Promise<T>;
  readTaskReceipts: ReturnType<typeof createRepositoryTaskPublicationReader>;
}): (() => Promise<PreparedRepositorySessionRead | undefined>) | undefined {
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
  let retained: PreparedRepositorySessionRead | undefined;
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
      params.lifetime.throwIfAborted();
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
  return async () => {
    try {
      params.lifetime.throwIfAborted();
      if (getSessionRowProjection() !== projection) {
        return undefined;
      }
      if (retained) {
        try {
          retained.assertCurrent();
          return retained;
        } catch {
          retained = undefined;
        }
      }
      const result = await withReadySessionRows(
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
          const record = read.describe(captured.query, captured.selected);
          const storePath = record?.storeTarget.storePath;
          if (!record || !storePath) {
            return undefined;
          }
          const sessionOnly = !roleScopesAllow({
            role: "operator",
            requestedScopes: [READ_SCOPE],
            allowedScopes: client.connect.scopes ?? [],
          });
          const repository = record.materialized.row.repository ?? null;
          const selected = {
            cfg: captured.cfg,
            agentId: record.agentId,
            canonicalKey: record.key,
            storePath,
            readSource: { agentId: record.storeTarget.agentId, path: storePath },
            entry: record.entry,
          };
          const observation = observeSelectedRepositorySession(selected, repository);
          if (!observation) {
            return undefined;
          }
          const privateRow = isIncognitoSessionKey(captured.selected.key);
          const rowContext = projection.readPreparedRowContext();
          if (privateRow && captured.selected.entry?.repositoryWorkspaceId && !rowContext) {
            return undefined;
          }
          let currentSelection = captured.selected;
          let currentFactsRevision = captured.selected.databaseFactsRevision;
          let currentConfig = captured.cfg;
          let currentRepository = repository;
          const originalBinding = record.entry.worktree?.githubPullRequest;
          const original = privateRow
            ? {
                generation: captured.selected.generation,
                sessionId: captured.selected.entry?.sessionId,
                lifecycleRevision: captured.selected.entry?.lifecycleRevision,
                rowContext,
              }
            : undefined;
          const assertCurrent = () => {
            params.lifetime.throwIfAborted();
            const current = captureCurrent();
            if (!current) {
              throw new Error("Session repository target changed");
            }
            if (!original) {
              if (
                current.selected !== currentSelection ||
                current.selected.databaseFactsRevision !== currentFactsRevision ||
                (current.selected.materialized?.row.repository ?? null) !== currentRepository ||
                current.cfg !== currentConfig
              ) {
                if (current.selected.generation !== currentSelection.generation) {
                  throw new Error("Session repository target changed");
                }
                if (!isPreparedSessionRowDatabaseFacts(current.selected.retainedDatabaseFacts)) {
                  throw new SessionRowFactsPending([current.query]);
                }
                const row = projection.describe(current.query, current.selected);
                const observed =
                  row &&
                  observeSelectedRepositorySession(
                    {
                      cfg: current.cfg,
                      agentId: row.agentId,
                      canonicalKey: row.key,
                      storePath: row.storeTarget.storePath,
                      readSource: {
                        agentId: row.storeTarget.agentId,
                        path: row.storeTarget.storePath,
                      },
                      entry: row.entry,
                    },
                    row.materialized.row.repository ?? null,
                  );
                if (
                  !row ||
                  observed?.identity !== observation.identity ||
                  (params.allowOwnImportedPullRequest &&
                    !isDeepStrictEqual(row.entry.worktree?.githubPullRequest, originalBinding))
                ) {
                  throw new Error("Session repository target changed");
                }
                currentSelection = row;
                currentFactsRevision = row.databaseFactsRevision;
                currentConfig = current.cfg;
                currentRepository = row.materialized.row.repository ?? null;
              }
              return;
            }
            const row = current.selected;
            if (
              row.generation !== original.generation ||
              row.entry?.sessionId !== original.sessionId ||
              row.entry?.lifecycleRevision !== original.lifecycleRevision ||
              (row.entry?.repositoryWorkspaceId &&
                (!original.rowContext ||
                  projection.readPreparedRowContext() !== original.rowContext)) ||
              observeSelectedRepositorySession(
                {
                  cfg: current.cfg,
                  agentId: row.agentId,
                  canonicalKey: row.key,
                  storePath: row.storeTarget.storePath,
                  readSource: { agentId: row.storeTarget.agentId, path: row.storeTarget.storePath },
                  entry: row.entry,
                },
                repository,
              )?.identity !== observation.identity
            ) {
              throw new Error("Session repository target changed");
            }
          };
          const target = prepareSelectedRepositorySessionRead(selected, repository, {
            assertCurrent,
            runSource: params.runSource,
          });
          if (!target) {
            return undefined;
          }
          if (sessionOnly) {
            const binding = record.entry.worktree?.githubPullRequest;
            if (
              !actorProfile ||
              !binding?.preparedHeadCommit ||
              !isSessionCreatorProfile(record.entry.createdActor, actorProfile)
            ) {
              return undefined;
            }
            const ownReader = captureOwnGitHubPullRequestReader(actorProfile, () =>
              resolveConfiguredGitHubHost(getRuntimeConfig()),
            );
            const assertOwnReaderCurrent = () => {
              target.assertCurrent();
              ownReader.assertCurrent();
            };
            return {
              ...target,
              boundPullRequest: binding,
              viewerProfileId: actorProfile,
              ownGitHubIdentity: ownReader.identity,
              assertCurrent: assertOwnReaderCurrent,
              preparedOwnPullRequestReader: {
                ...ownReader,
                assertCurrent: assertOwnReaderCurrent,
              },
            };
          }
          return withRepositoryTaskAudience(
            params.allowOwnImportedPullRequest
              ? { ...target, boundPullRequest: record.entry.worktree?.githubPullRequest }
              : target,
            projection,
            record,
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
            params.readTaskReceipts,
            actorProfile,
          );
        },
      );
      retained = result?.viewerProfileId || isIncognitoSessionKey(sessionKey) ? undefined : result;
      return result;
    } catch {
      return undefined;
    }
  };
}

/** Internal CI reads retain their existing visibility policy and exact durable/memory selection. */
export async function withRepositoryInternalSessionRead<T>(
  params: {
    getConfig: () => OpenClawConfig;
    query: { sessionKey: string; agentId?: string };
    assertCurrent: () => void;
  },
  consume: (read: PreparedRepositorySessionRead | undefined) => Promise<T>,
): Promise<T> {
  params.assertCurrent();
  const cfg = params.getConfig();
  const requested = resolveRequestedSessionAgentId(
    cfg,
    params.query.sessionKey,
    params.query.agentId,
  );
  if (!requested.ok) {
    return consume(undefined);
  }
  const fields = [
    "repositoryWorkspaceId",
    "worktree",
    "spawnedCwd",
    "spawnedWorkspaceDir",
    "pendingWorktree",
    "pendingProjectGitUrl",
    "deviceFolder",
  ] as const;
  const selected = await retainGatewaySessionEntryReadOnly(
    params.query.sessionKey,
    requested.agentId,
    (previous, current) =>
      fields.every((field) => isDeepStrictEqual(previous[field], current[field])),
    cfg,
    { exactRead: true },
  );
  try {
    params.assertCurrent();
    const entry = selected.entry;
    if (!entry?.sessionId) {
      return await consume(undefined);
    }
    const workspaceId = entry.repositoryWorkspaceId;
    const workspace = workspaceId
      ? await getSessionRepositoryWorkspaceStore().prepare(workspaceId)
      : undefined;
    const current = () => {
      params.assertCurrent();
      const currentConfig = params.getConfig();
      if (
        !selected.isCurrentAtResponse() ||
        createSessionListEntryFilter({ cfg: currentConfig, client: null })?.(
          selected.canonicalKey,
          entry,
        ) === false
      ) {
        return undefined;
      }
      const repository = workspace?.current();
      return {
        cfg: currentConfig,
        repository:
          repository?.workspaceId === workspaceId &&
          repository?.agentId === selected.agentId &&
          repository.sessionKey === selected.canonicalKey
            ? repository
            : null,
      };
    };
    const captured = current();
    if (!captured) {
      return await consume(undefined);
    }
    const observation = observeSelectedRepositorySession(
      { ...selected, cfg: captured.cfg },
      captured.repository,
    );
    if (!observation) {
      return await consume(undefined);
    }
    const assertCurrent = () => {
      const facts = current();
      if (
        !facts ||
        observeSelectedRepositorySession({ ...selected, cfg: facts.cfg }, facts.repository)
          ?.identity !== observation.identity
      ) {
        throw new Error("Repository session target changed");
      }
    };
    const read = prepareSelectedRepositorySessionRead(
      { ...selected, cfg: captured.cfg },
      captured.repository,
      { assertCurrent, runSource: (run) => run() },
    );
    return await consume(read);
  } finally {
    selected.release();
  }
}

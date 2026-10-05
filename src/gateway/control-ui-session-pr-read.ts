import {
  resolveConfiguredGitHubApiBaseUrl,
  resolveConfiguredGitHubHost,
} from "../agents/github-host.js";
import { getRuntimeConfig as readRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitCheckoutContext } from "../infra/git-read-operations.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import { configuredDefaultRepository } from "./configured-default-repository.js";
import { factoryGitHubRequestDigest } from "./factory-github-proof.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { hasCurrentGatewayOperatorAccess } from "./operator-access-policy.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import { READ_SCOPE } from "./operator-scopes.js";
import { prepareGatewayProjectGitHubIdentity } from "./project-github-identity.js";
import { isGatewayClientProfilePending } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { withReadySessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import type { MaterializedRow } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { createSessionListEntryFilter, resolveSessionVisibility } from "./session-sharing.js";
import type { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";

type SelectedSession = Pick<
  ReturnType<typeof loadGatewaySessionEntryReadOnly>,
  "cfg" | "agentId" | "canonicalKey" | "storePath" | "readSource" | "entry"
>;

export type ControlUiSessionPrTarget = {
  sessionId: string;
  lifecycleRevision?: string;
  client?: GatewayClient;
  params: { sessionKey: string; agentId: string };
  identity: string;
  readSource: { agentId: string; path: string };
  source: string | GitCheckoutContext | null;
  githubHost?: string;
  refreshIndex?: boolean;
  assertCurrent?: () => void;
};

export type ControlUiSessionPrReadContext = {
  target: ControlUiSessionPrTarget;
  sourceIdentity: string;
  // Internal consumers can inspect all fetched PRs without expanding the UI.
  projection?: "publication";
  assertCurrent: () => void;
};

export function resolveControlUiSessionGitHubRepository(
  target: ControlUiSessionPrTarget,
  config: OpenClawConfig,
): { owner: string; repo: string; host: string } | null {
  if (target.source && typeof target.source !== "string") {
    return { ...target.source, host: target.source.host ?? "github.com" };
  }
  if (process.env.FACTORY_AUTH_MODE !== "github") {
    return null;
  }
  const host = resolveConfiguredGitHubHost(config);
  const selected = configuredDefaultRepository(config);
  const remote = selected && parseGitHubRemoteUrl(selected.url, host);
  return remote ? { ...remote, host } : null;
}

/** Private reads inherit the visible session's repository, never the pasted URL. */
export async function prepareControlUiSessionGitHubIdentity(
  read: Pick<ControlUiSessionPrReadContext, "target" | "assertCurrent">,
  getConfig: () => OpenClawConfig = readRuntimeConfig,
  requestUrl?: string,
) {
  const config = getConfig();
  const repository = resolveControlUiSessionGitHubRepository(read.target, config);
  if (!repository) {
    if (process.env.FACTORY_AUTH_MODE === "github") {
      throw new Error("Factory GitHub session repository is unavailable");
    }
    return undefined;
  }
  const host = repository.host;
  const apiBaseUrl = resolveConfiguredGitHubApiBaseUrl(config);
  if (resolveConfiguredGitHubHost(config) !== host) {
    if (process.env.FACTORY_AUTH_MODE === "github") {
      throw new Error("Factory GitHub repository host does not match the configured issuer");
    }
    return undefined;
  }
  const assertCurrent = () => {
    read.assertCurrent();
    read.target.assertCurrent?.();
    const current = getConfig();
    if (
      resolveConfiguredGitHubHost(current) !== host ||
      resolveConfiguredGitHubApiBaseUrl(current) !== apiBaseUrl ||
      JSON.stringify(resolveControlUiSessionGitHubRepository(read.target, current)) !==
        JSON.stringify(repository)
    ) {
      throw new Error("GitHub repository selection changed during the session read.");
    }
  };
  assertCurrent();
  if (process.env.FACTORY_AUTH_MODE === "github" && !read.target.sessionId) {
    throw new Error("Factory GitHub item read requires its exact session and target");
  }
  const targetUrl =
    requestUrl ??
    `https://${host}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const identity = await prepareGatewayProjectGitHubIdentity({
    agentId: read.target.params.agentId,
    config,
    context: { getRuntimeConfig: getConfig },
    assertActive: assertCurrent,
    client: read.target.client,
    sessionKey: read.target.params.sessionKey,
    factoryCredential: {
      claim: {
        purpose: "session-item-read",
        binding: {
          kind: "session",
          agentId: read.target.params.agentId,
          sessionKey: read.target.params.sessionKey,
          sessionId: read.target.sessionId,
          lifecycleRevision: read.target.lifecycleRevision ?? null,
          requestDigest: factoryGitHubRequestDigest(targetUrl),
        },
      },
      assertCurrent,
    },
  });
  assertCurrent();
  if (process.env.FACTORY_AUTH_MODE === "github" && !identity) {
    throw new Error("Factory GitHub session identity is unavailable");
  }
  return identity
    ? {
        ...identity,
        host,
        apiBaseUrl,
        cacheScope: JSON.stringify([
          repository.host,
          repository.owner,
          repository.repo,
          read.target.identity,
          identity.cacheScope,
        ]),
        repository: { owner: repository.owner, repo: repository.repo },
      }
    : undefined;
}

/** Git facts and cached snapshots belong to the recorded session and workspace source. */
export function resolveControlUiSessionPrTarget(
  selected: SelectedSession,
  preparedRepository: GatewaySessionRow["repository"] | null,
): ControlUiSessionPrTarget | undefined {
  const { cfg, agentId, canonicalKey, storePath, readSource, entry } = selected;
  if (!entry?.sessionId || !storePath || !readSource) {
    return undefined;
  }
  let source: ControlUiSessionPrTarget["source"];
  const githubHost = resolveConfiguredGitHubHost(cfg);
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
      source,
      githubHost,
    ]),
    source,
    refreshIndex: Boolean(entry.worktree && !entry.repositoryWorkspaceId),
  };
}

export function resolveProjectedControlUiSessionPrTarget(
  cfg: OpenClawConfig,
  record: MaterializedRow,
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
  );
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
export async function prepareControlUiSessionPrRead(params: {
  client: GatewayClient;
  sessionKey: string;
  agentId?: string;
  getRuntimeConfig: () => OpenClawConfig;
  getSessionRowProjection: () => SessionRowProjection | undefined;
  isCurrentClient: () => boolean;
}): Promise<ControlUiSessionPrRead | undefined> {
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
  const factoryActorInput = client.authenticatedFactoryGitHubAccountId;
  const scopes = [...(client.connect.scopes ?? [])].toSorted().join("\0");
  const access = client.internal?.operatorAccessAuthority;
  const connectionSignal = client.connectionSignal;
  const projection = getSessionRowProjection();
  if (!projection) {
    return undefined;
  }
  let profileAccess: ReturnType<typeof captureResidentUserProfileAccess> | undefined;
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
        client.authenticatedFactoryGitHubAccountId !== factoryActorInput ||
        currentActor?.kind !== actorKind ||
        (currentActor?.kind === "operator" ? currentActor.profileId : undefined) !== actorProfile ||
        [...(client.connect.scopes ?? [])].toSorted().join("\0") !== scopes ||
        client.internal?.operatorAccessAuthority !== access ||
        !hasCurrentGatewayOperatorAccess(access)
      ) {
        return undefined;
      }
      if (actorProfile) {
        profileAccess ??= captureResidentUserProfileAccess(actorProfile);
        if (profileAccess.assertCurrent().id !== actorProfile) {
          return undefined;
        }
      }
      const cfg = getRuntimeConfig();
      if (
        authorizeCurrentOperatorRoleScopes(client, cfg) ||
        !roleScopesAllow({
          role: "operator",
          requestedScopes: [READ_SCOPE],
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
      const target = resolveProjectedControlUiSessionPrTarget(captured.cfg, current);
      return target ? { target, repository } : undefined;
    } catch {
      return undefined;
    }
  };
  const readCurrent: ControlUiSessionPrRead = async () => {
    try {
      if (getSessionRowProjection() !== projection) {
        return undefined;
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
      return target
        ? {
            ...target.target,
            client,
            assertCurrent: () => {
              const current = captureCurrent();
              const original = target.privateSource;
              if (!current) {
                throw new Error("Session pull-request target changed");
              }
              if (!original) {
                if (
                  current.selected !== target.captured ||
                  !target.captured ||
                  !projection.isCurrent(target.captured)
                ) {
                  throw new Error("Session pull-request target changed");
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
                )?.identity !== target.target.identity
              ) {
                throw new Error("Session pull-request target changed");
              }
            },
          }
        : undefined;
    } catch {
      return undefined;
    }
  };
  return (await readCurrent()) ? readCurrent : undefined;
}

/** Conversation links stay available independently of GitHub credential verification. */
export async function readControlUiSessionIssueReferences(
  read: ControlUiSessionPrReadContext,
  repository: { owner: string; repo: string; host?: string },
) {
  read.assertCurrent();
  const { readSessionTranscriptSummaryAsync } = await import("./session-transcript-readers.js");
  read.assertCurrent();
  const result = await readSessionTranscriptSummaryAsync(
    {
      agentId: read.target.readSource.agentId,
      sessionKey: read.target.params.sessionKey,
      sessionId: read.target.sessionId,
      storePath: read.target.readSource.path,
      sessionEntry: { sessionId: read.target.sessionId },
    },
    { kind: "github-issue-references", host: repository.host ?? "github.com", repository },
  );
  read.assertCurrent();
  return result.issues;
}

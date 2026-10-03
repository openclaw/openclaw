import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitCheckoutContext } from "../infra/git-read-operations.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { readUserProfileAliasRevision } from "../state/user-profile-events.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { hasCurrentGatewayOperatorAccess } from "./operator-access-policy.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import { READ_SCOPE } from "./operator-scopes.js";
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
  params: { sessionKey: string; agentId: string };
  identity: string;
  readSource: { agentId: string; path: string };
  source: string | GitCheckoutContext | null;
  assertCurrent?: () => void;
};

export type ControlUiSessionPrReadContext = {
  target: ControlUiSessionPrTarget;
  sourceIdentity: string;
  // Internal consumers can inspect all fetched PRs without expanding the UI.
  projection?: "publication";
  assertCurrent: () => void;
};

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
  if (entry.repositoryWorkspaceId) {
    const repository = preparedRepository;
    const remote = repository ? parseGitHubRemoteUrl(repository.url) : null;
    source = remote && repository ? { ...remote, branch: repository.branch } : null;
  } else {
    source = resolveSessionWorkspaceRoots(cfg, agentId, entry).diffCwd ?? null;
  }
  return {
    params: { sessionKey: canonicalKey, agentId },
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
    ]),
    source,
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
  const scopes = [...(client.connect.scopes ?? [])].toSorted().join("\0");
  const access = client.internal?.operatorAccessAuthority;
  const connectionSignal = client.connectionSignal;
  const projection = getSessionRowProjection();
  if (!projection) {
    return undefined;
  }
  let aliasRevision = -1;
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
        if (actorProfile && resolveUserProfileId(actorProfile) !== actorProfile) {
          return undefined;
        }
        aliasRevision = currentAliasRevision;
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

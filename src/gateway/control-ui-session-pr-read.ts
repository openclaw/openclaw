import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitCheckoutContext } from "../infra/git-read-operations.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
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
import type { SessionRowProjection } from "./session-row-projection.js";
import { createSessionListEntryFilter } from "./session-sharing.js";
import type { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

type SelectedSession = Pick<
  ReturnType<typeof loadGatewaySessionEntryReadOnly>,
  "cfg" | "agentId" | "canonicalKey" | "storePath" | "readSource" | "entry"
>;

export type ControlUiSessionPrTarget = {
  params: { sessionKey: string; agentId: string };
  identity: string;
  readSource: { agentId: string; path: string };
  source: string | GitCheckoutContext | null;
};

export type ControlUiSessionPrReadContext = {
  target: ControlUiSessionPrTarget;
  sourceIdentity: string;
  assertCurrent: () => void;
};

/** Git facts and cached snapshots belong to the recorded session and workspace source. */
export function resolveControlUiSessionPrTarget(
  selected: SelectedSession,
  preparedRepository?: GatewaySessionRow["repository"] | null,
): ControlUiSessionPrTarget | undefined {
  const { cfg, agentId, canonicalKey, storePath, readSource, entry } = selected;
  if (!entry?.sessionId || !storePath || !readSource) {
    return undefined;
  }
  let source: ControlUiSessionPrTarget["source"];
  if (entry.repositoryWorkspaceId) {
    let repository = preparedRepository;
    if (repository === undefined) {
      const workspace = getSessionRepositoryWorkspaceStore().get(entry.repositoryWorkspaceId);
      repository =
        workspace?.agentId === agentId && workspace.sessionKey === canonicalKey ? workspace : null;
    }
    const remote = repository ? parseGitHubRemoteUrl(repository.url) : null;
    source = remote && repository ? { ...remote, branch: repository.branch } : null;
  } else {
    source =
      normalizeOptionalString(entry.spawnedCwd) ??
      normalizeOptionalString(entry.spawnedWorkspaceDir) ??
      normalizeOptionalString(resolveAgentWorkspaceDir(cfg, agentId)) ??
      null;
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

export type ControlUiSessionPrRead = () => ControlUiSessionPrTarget | undefined;

/** A watcher may follow a replaced target, but never a replacement person or access grant. */
export function prepareControlUiSessionPrRead(params: {
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
  let aliasRevision = -1;
  const readCurrent = () => {
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
      const projection = getSessionRowProjection();
      if (!projection) {
        return undefined;
      }
      const query = { key: sessionKey, agentId: requested.agentId };
      const selected = projection.capture(query);
      if (
        !selected?.entry ||
        !projection.isCurrent(selected) ||
        createSessionListEntryFilter({ cfg, client })?.(selected.key, selected.entry) === false
      ) {
        return undefined;
      }
      // Authorize transient private rows before preparing presentation; resident rows reuse it.
      const current = projection.describe(query, selected);
      const storePath = current?.storeTarget.storePath;
      if (!current || !storePath) {
        return undefined;
      }
      return resolveControlUiSessionPrTarget(
        {
          cfg,
          agentId: current.agentId,
          canonicalKey: current.key,
          storePath,
          readSource: { agentId: current.storeTarget.agentId, path: storePath },
          entry: current.entry,
        },
        current.materialized.row.repository ?? null,
      );
    } catch {
      return undefined;
    }
  };
  return readCurrent() ? readCurrent : undefined;
}

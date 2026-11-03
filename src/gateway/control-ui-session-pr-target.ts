import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import type { OpenClawConfig } from "../plugin-sdk/core.js";
import type {
  NativeGitHubPullRequestBinding as SessionGitHubPullRequestBinding,
  PreparedNativeGitHubSessionRead as PreparedRepositorySessionRead,
  RepositorySessionObservation,
  NativeGitHubSessionReads as RepositorySessionReads,
  RepositorySessionSourceScope,
  ControlUiSessionPullRequests,
} from "../plugin-sdk/native-github-session-read.js";
import type { GitHubCheckoutContext } from "./control-ui-session-pr-checkout.js";
import type { SessionPullRequestReadCredential } from "./control-ui-session-pr-request.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";

export type ControlUiSessionPrTarget = {
  githubPullRequest?: SessionGitHubPullRequestBinding;
  ownGitHubProfileId?: string;
  ownGitHubIdentity?: string;
  sessionId: string;
  lifecycleRevision?: string | null;
  params: { sessionKey: string; agentId: string };
  identity: string;
  branchIdentity: string;
  taskAudienceKey?: string;
  includesTaskPublications: boolean;
  taskReceiptsOnly?: boolean;
  observation: RepositorySessionObservation;
  read?: PreparedRepositorySessionRead;
  source: string | GitHubCheckoutContext | null;
  githubHost: string;
  refreshIndex: boolean;
  assertCurrent?: () => void;
};

export type ControlUiSessionPrReadContext = {
  target: ControlUiSessionPrTarget;
  sourceIdentity: string;
  sourceScope: RepositorySessionSourceScope;
  readTaskPublications?: PreparedRepositorySessionRead["readTaskPublications"];
  projection?: "publication";
  retainReadAuthority?: (
    assertCurrent: () => void,
    credential?: SessionPullRequestReadCredential,
  ) => void;
  onBranchRead?: (snapshot: ControlUiSessionPullRequests) => void;
  branchSnapshot?: ControlUiSessionPullRequests;
  assertCurrent: () => void;
};

/** GitHub interprets repository facts; the host alone selects and authorizes their source. */
export function repositorySessionPrTarget(
  observation: RepositorySessionObservation,
  config: OpenClawConfig,
  read?: PreparedRepositorySessionRead,
): ControlUiSessionPrTarget {
  const githubHost = resolveConfiguredGitHubHost(config);
  const source = observation.source;
  const publicRemote = source?.kind === "repository" ? parseGitHubRemoteUrl(source.url) : null;
  const remote =
    publicRemote ??
    (source?.kind === "repository" ? parseGitHubRemoteUrl(source.url, githubHost) : null);
  const branchSource = JSON.stringify([
    observation.branchIdentity,
    read?.boundPullRequest,
    githubHost,
  ]);
  const branchIdentity = read?.ownGitHubIdentity
    ? JSON.stringify([branchSource, read.ownGitHubIdentity])
    : branchSource;
  return {
    sessionId: observation.session.sessionId,
    lifecycleRevision: observation.session.lifecycleRevision,
    params: { sessionKey: observation.session.sessionKey, agentId: observation.session.agentId },
    identity: read?.ownGitHubIdentity
      ? branchIdentity
      : JSON.stringify([observation.identity, read?.boundPullRequest, githubHost]),
    ...(read?.boundPullRequest ? { githubPullRequest: read.boundPullRequest } : {}),
    ...(read?.viewerProfileId
      ? { ownGitHubProfileId: read.viewerProfileId, ownGitHubIdentity: read.ownGitHubIdentity }
      : {}),
    branchIdentity,
    includesTaskPublications: read?.includesTaskPublications ?? false,
    ...(read?.taskAudienceKey ? { taskAudienceKey: read.taskAudienceKey } : {}),
    observation,
    ...(read ? { read, assertCurrent: read.assertCurrent } : {}),
    source:
      source?.kind === "checkout"
        ? source.root
        : remote && source?.kind === "repository"
          ? { ...remote, ...(!publicRemote ? { host: githubHost } : {}), branch: source.branch }
          : null,
    githubHost,
    refreshIndex: observation.refreshIndex,
  };
}

export type ControlUiSessionPrRead = () => Promise<ControlUiSessionPrTarget | undefined>;

export function createControlUiSessionPrRead(
  read: (() => Promise<PreparedRepositorySessionRead | undefined>) | undefined,
  getConfig: () => OpenClawConfig,
): ControlUiSessionPrRead | undefined {
  let previousRead: PreparedRepositorySessionRead | undefined;
  let previousConfig: OpenClawConfig | undefined;
  let previousTarget: ControlUiSessionPrTarget | undefined;
  return read
    ? async () => {
        const selected = await read();
        if (!selected) {
          previousRead = undefined;
          previousTarget = undefined;
          return undefined;
        }
        const config = getConfig();
        if (selected !== previousRead || config !== previousConfig) {
          previousRead = selected;
          previousConfig = config;
          previousTarget = repositorySessionPrTarget(selected, config, selected);
        }
        return previousTarget;
      }
    : undefined;
}

export async function prepareControlUiSessionPrServiceTarget(
  reads: RepositorySessionReads,
  getConfig: () => OpenClawConfig,
  query: { sessionKey: string; agentId: string },
): Promise<ControlUiSessionPrTarget | undefined> {
  const selected = await reads.prepareServiceRead(query);
  return selected ? repositorySessionPrTarget(selected, getConfig(), selected) : undefined;
}

import { resolveConfiguredGitHubToolIdentity } from "../../agents/github-tool-identity.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import {
  parseWorkerGitHubLaunchBinding,
  type WorkerGitHubLaunchBinding,
} from "../../worker/launch-descriptor.js";
import {
  currentGitHubPublicationConfig,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  prepareGitHubPublicationWorkspaceOwner,
  sameGitHubPublicationWorkspace,
  type PublicationSessionIdentity,
} from "../github-publication-availability.js";
import { parseGitHubRemoteUrl } from "../github-remote.js";

export async function prepareGitHubPublicationFact(
  params: PublicationSessionIdentity & {
    assertCurrent?: () => boolean;
  },
): Promise<{ available: boolean; github?: WorkerGitHubLaunchBinding } | undefined> {
  try {
    if (params.assertCurrent?.() === false) {
      return undefined;
    }
    const currentWorkspace = await prepareGitHubPublicationWorkspaceOwner(params);
    const workspace = currentWorkspace.initial;
    const identity = await prepareCurrentGitHubPublicationIdentity(params.agentId);
    const originUrl =
      workspace.kind === "repository"
        ? workspace.workspace.url
        : (await managedWorktrees.resolveRepositoryIdentity(workspace.worktree.path)).originUrl;
    const current = await currentWorkspace.read();
    if (
      params.assertCurrent?.() === false ||
      !sameGitHubPublicationWorkspace(workspace, current) ||
      !matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity })
    ) {
      return undefined;
    }
    const remote = parseGitHubRemoteUrl(originUrl);
    const remoteUrl =
      remote && /^[A-Za-z0-9_.-]+$/u.test(remote.owner) && /^[A-Za-z0-9_.-]+$/u.test(remote.repo)
        ? `https://github.com/${remote.owner}/${remote.repo}.git`
        : undefined;
    const scope =
      identity.source === "agent-override"
        ? "agent"
        : identity.source === "system-configured"
          ? "system"
          : undefined;
    const gitAuthor = scope
      ? resolveConfiguredGitHubToolIdentity({
          config: currentGitHubPublicationConfig(),
          agentId: params.agentId,
          scope,
        })?.gitAuthor
      : undefined;
    const binding = parseWorkerGitHubLaunchBinding({
      token: identity.env.GH_TOKEN,
      login: identity.account.login,
      branch:
        workspace.kind === "repository" ? workspace.workspace.branch : workspace.worktree.branch,
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(gitAuthor ? { gitAuthor } : {}),
    });
    return { available: Boolean(identity.env.GH_TOKEN), ...(binding ? { github: binding } : {}) };
  } catch {
    return undefined;
  }
}

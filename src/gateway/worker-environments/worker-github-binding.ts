import { resolveGitHubHost } from "../../agents/github-host.js";
import { resolveConfiguredGitHubToolIdentity } from "../../agents/github-tool-identity.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  parseWorkerGitHubLaunchBinding,
  type WorkerGitHubLaunchBinding,
} from "../../worker/launch-descriptor.js";
import {
  currentGitHubPublicationConfig,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  resolveGitHubPublicationWorkspaceOwner,
  sameGitHubPublicationWorkspace,
} from "../github-publication-availability.js";
import { parseGitHubRemoteUrl } from "../github-remote.js";
import { issueWorkerGitHubInstallationToken } from "./worker-github-installation-token.js";

export type WorkerGitHubBinding = WorkerGitHubLaunchBinding;

const log = createSubsystemLogger("gateway/worker-github");

export type WorkerGitHubBindingGrant = {
  binding: WorkerGitHubBinding;
  expiresAtMs?: number;
  revoke: () => Promise<void>;
};

export async function prepareWorkerGitHubBindingGrant(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent?: () => boolean;
}): Promise<WorkerGitHubBindingGrant | undefined> {
  if (params.assertCurrent?.() === false) return undefined;
  const workspace = resolveGitHubPublicationWorkspaceOwner(params);
  const originUrl =
    workspace.kind === "repository"
      ? workspace.workspace.url
      : (await managedWorktrees.resolveRepositoryIdentity(workspace.worktree.path)).originUrl;
  if (params.assertCurrent?.() === false) return undefined;
  const githubHost = resolveGitHubHost();
  const remote = parseGitHubRemoteUrl(originUrl, githubHost);
  if (
    !remote ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.repo)
  ) {
    return undefined;
  }
  const appGrant = await issueWorkerGitHubInstallationToken({});
  if (!appGrant) {
    const binding = await prepareWorkerGitHubBinding(params);
    return binding ? { binding, revoke: async () => {} } : undefined;
  }
  if (
    params.assertCurrent?.() === false ||
    !sameGitHubPublicationWorkspace(workspace, resolveGitHubPublicationWorkspaceOwner(params))
  ) {
    await appGrant.revoke();
    return undefined;
  }
  const binding = parseWorkerGitHubLaunchBinding({
    token: appGrant.token,
    login: "x-access-token",
    ...(githubHost === "github.com" ? {} : { host: githubHost }),
    branch:
      workspace.kind === "repository" ? workspace.workspace.branch : workspace.worktree.branch,
    remoteUrl: `https://${githubHost}/${remote.owner}/${remote.repo}.git`,
  });
  if (!binding) {
    await appGrant.revoke();
    throw new Error("Worker GitHub App binding does not meet the launch contract");
  }
  return { binding, expiresAtMs: appGrant.expiresAtMs, revoke: appGrant.revoke };
}

export async function prepareWorkerGitHubBinding(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent?: () => boolean;
}): Promise<WorkerGitHubBinding | undefined> {
  try {
    if (params.assertCurrent?.() === false) {
      return undefined;
    }
    const workspace = resolveGitHubPublicationWorkspaceOwner(params);
    const identity = await prepareCurrentGitHubPublicationIdentity(params.agentId).catch(() => {
      const config = currentGitHubPublicationConfig();
      const managed = (["agent", "system"] as const).some((scope) =>
        resolveConfiguredGitHubToolIdentity({ config, agentId: params.agentId, scope }),
      );
      if (managed && params.assertCurrent?.() !== false) {
        log.warn(
          "Worker GitHub identity unavailable; reconnect the shared GitHub account in Settings.",
        );
      } else {
        log.debug("Worker GitHub identity unavailable.");
      }
      return undefined;
    });
    if (!identity || params.assertCurrent?.() === false) {
      return undefined;
    }
    const originUrl =
      workspace.kind === "repository"
        ? workspace.workspace.url
        : (await managedWorktrees.resolveRepositoryIdentity(workspace.worktree.path)).originUrl;
    if (params.assertCurrent?.() === false) {
      return undefined;
    }
    if (
      !sameGitHubPublicationWorkspace(workspace, resolveGitHubPublicationWorkspaceOwner(params)) ||
      !matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity })
    ) {
      return undefined;
    }
    const token = identity.env.GH_TOKEN;
    if (!token) {
      return undefined;
    }
    const githubHost = resolveGitHubHost();
    const remote = parseGitHubRemoteUrl(originUrl, githubHost);
    const remoteUrl =
      remote && /^[A-Za-z0-9_.-]+$/u.test(remote.owner) && /^[A-Za-z0-9_.-]+$/u.test(remote.repo)
        ? `https://${githubHost}/${remote.owner}/${remote.repo}.git`
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
      token,
      login: identity.account.login,
      ...(githubHost === "github.com" ? {} : { host: githubHost }),
      branch:
        workspace.kind === "repository" ? workspace.workspace.branch : workspace.worktree.branch,
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(gitAuthor ? { gitAuthor } : {}),
    });
    if (!binding) {
      log.debug("Worker GitHub binding does not meet the worker launch contract.");
    }
    return binding;
  } catch {
    log.debug("Worker GitHub binding unavailable for the current session workspace.");
    return undefined;
  }
}

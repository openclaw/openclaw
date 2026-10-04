import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { GITHUB_PUBLIC_HOST } from "../../agents/github-host.js";
import {
  resolveConfiguredGitHubToolIdentity,
  onManagedGitHubProfileChanged,
} from "../../agents/github-tool-identity.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { registerConfigWriteListener } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  onUserProfileEmailBindingChanged,
  onUserProfilesChanged,
} from "../../state/user-profile-events.js";
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
} from "../github-publication-availability.js";
import {
  GitHubPublicationSessionChangedError,
  GitHubPublicationWorkspaceChangedError,
} from "../github-publication-failure.js";
import { parseGitHubRemoteUrl } from "../github-remote.js";
import type { WorkerGitHubBindingGrant } from "./worker-github-binding-contract.js";
import { createWorkerGitHubBindingGrant } from "./worker-github-grant.js";

const log = createSubsystemLogger("gateway/worker-github");

export type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "./worker-github-binding-contract.js";

/** Credential cleanup cannot erase work already accepted by its execution owner. */
export async function revokeWorkerGitHubBindingGrant(
  grant: WorkerGitHubBindingGrant | undefined,
): Promise<void> {
  try {
    await grant?.revoke();
  } catch {
    log.warn(
      "Worker GitHub cleanup failed; accepted work still reconciles and final cleanup can retry.",
    );
  }
}

export async function prepareWorkerGitHubBindingGrant(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent?: () => boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  signal?: AbortSignal;
}): Promise<WorkerGitHubBindingGrant | undefined> {
  if (params.signal?.aborted || params.assertCurrent?.() === false) {
    return undefined;
  }
  const caller = getGatewayToolCallerIdentity();
  const operator =
    params.operatorAuthority ??
    (caller?.agentId === params.agentId && caller.sessionKey === params.sessionKey
      ? caller.operatorAuthority
      : undefined);
  if (operator) {
    assertAdmittedRunOperatorAuthority(operator);
    operator.assertCurrent();
  }
  const controller = new AbortController();
  const signal = AbortSignal.any(
    [params.signal, operator?.signal, controller.signal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    ),
  );
  const preparedWorkspace = await prepareGitHubPublicationWorkspaceOwner(params, {
    allowMissingWorkspace: true,
  });
  signal.throwIfAborted();
  operator?.assertCurrent();
  if (params.assertCurrent?.() === false) {
    return undefined;
  }
  const workspace = preparedWorkspace.initial;
  const assertAuthority = () => {
    signal.throwIfAborted();
    operator?.assertCurrent();
    if (
      params.assertCurrent?.() === false ||
      !sameGitHubPublicationWorkspace(workspace, preparedWorkspace.current())
    ) {
      throw new Error("Worker GitHub credential authority closed");
    }
  };
  const refreshWorkspace = async () => {
    const current = await preparedWorkspace.read().catch((error: unknown) => {
      if (
        error instanceof GitHubPublicationSessionChangedError ||
        error instanceof GitHubPublicationWorkspaceChangedError
      ) {
        // A newer worker snapshot can revoke authority before the local projection catches up.
        controller.abort(error);
      }
      throw error;
    });
    assertAuthority();
    if (!sameGitHubPublicationWorkspace(workspace, current)) {
      const error = new Error("Worker GitHub credential authority closed");
      controller.abort(error);
      throw error;
    }
  };
  assertAuthority();
  let profileRevision = 0;
  let preparedProfileRevision = 0;
  let preparingProfileDir: string | undefined;
  // Cover preparation awaits until the constructed grant installs its own profile listener.
  using _ = {
    [Symbol.dispose]: onManagedGitHubProfileChanged((profileDir) => {
      if (preparingProfileDir === undefined || preparingProfileDir === profileDir) {
        profileRevision++;
      }
    }),
  };
  let identity: Awaited<ReturnType<typeof prepareCurrentGitHubPublicationIdentity>>;
  let originUrl: string | undefined;
  do {
    preparedProfileRevision = profileRevision;
    try {
      identity = await prepareCurrentGitHubPublicationIdentity(params.agentId);
    } catch (error) {
      assertAuthority();
      const config = currentGitHubPublicationConfig();
      if (
        (["agent", "system"] as const).some((scope) =>
          resolveConfiguredGitHubToolIdentity({ config, agentId: params.agentId, scope }),
        )
      ) {
        throw new Error(
          "The selected GitHub identity is unavailable; reconnect it in Settings before starting this turn.",
          { cause: error },
        );
      }
      return undefined;
    }
    preparingProfileDir = identity.env.GH_CONFIG_DIR;
    assertAuthority();
    originUrl =
      workspace.kind === "none"
        ? undefined
        : workspace.kind === "repository"
          ? workspace.workspace.url
          : (await managedWorktrees.resolveRepositoryIdentity(workspace.worktree.path)).originUrl;
    await refreshWorkspace();
  } while (preparedProfileRevision !== profileRevision);
  const assertCurrent = () => {
    assertAuthority();
    if (!matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity })) {
      throw new Error("Selected GitHub identity changed; start a new turn.");
    }
  };
  assertCurrent();
  const githubHost = identity.host ?? GITHUB_PUBLIC_HOST;
  const remote = originUrl ? parseGitHubRemoteUrl(originUrl, githubHost) : undefined;
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
    ...(githubHost !== GITHUB_PUBLIC_HOST ? { host: githubHost } : {}),
    ...(workspace.kind === "none"
      ? {}
      : {
          branch:
            workspace.kind === "repository"
              ? workspace.workspace.branch
              : workspace.worktree.branch,
        }),
    ...(remote ? { remoteUrl: `https://${githubHost}/${remote.owner}/${remote.repo}.git` } : {}),
    ...(gitAuthor ? { gitAuthor } : {}),
  });
  if (!binding) {
    throw new Error("Selected GitHub identity does not meet the worker launch contract");
  }
  const refreshCredential = async () => {
    assertCurrent();
    let currentIdentity: typeof identity;
    let revision: number;
    do {
      revision = profileRevision;
      currentIdentity = await prepareCurrentGitHubPublicationIdentity(params.agentId);
      await refreshWorkspace();
      assertCurrent();
    } while (revision !== profileRevision);
    if (
      currentIdentity.source !== identity.source ||
      currentIdentity.profileId !== identity.profileId ||
      (currentIdentity.host ?? GITHUB_PUBLIC_HOST) !== githubHost ||
      currentIdentity.account.accountId !== identity.account.accountId ||
      currentIdentity.account.login.toLowerCase() !== identity.account.login.toLowerCase()
    ) {
      controller.abort(new Error("Selected GitHub account changed; start a new turn."));
      signal.throwIfAborted();
    }
    const token = currentIdentity.env.GH_TOKEN;
    if (!token) {
      throw new Error("Selected GitHub credential is unavailable; reconnect it in Settings.");
    }
    preparedProfileRevision = revision;
    return { token, expiresAtMs: currentIdentity.accessExpiresAtMs };
  };
  return createWorkerGitHubBindingGrant({
    binding,
    credential: { token: binding.token, expiresAtMs: identity.accessExpiresAtMs },
    controller,
    signal,
    assertCurrent,
    refreshCredential,
    refreshRequired: () => profileRevision !== preparedProfileRevision,
    subscribe: (changed) => [
      registerConfigWriteListener(changed),
      onManagedGitHubProfileChanged((profileDir) => {
        if (identity.env.GH_CONFIG_DIR === profileDir) {
          profileRevision++;
          changed();
        }
      }),
      onUserProfilesChanged(changed),
      onUserProfileEmailBindingChanged(changed),
    ],
  });
}

export async function prepareWorkerGitHubBinding(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent?: () => boolean;
}): Promise<WorkerGitHubLaunchBinding | undefined> {
  try {
    if (params.assertCurrent?.() === false) {
      return undefined;
    }
    const currentWorkspace = await prepareGitHubPublicationWorkspaceOwner(params);
    const workspace = currentWorkspace.initial;
    if (params.assertCurrent?.() === false) {
      return undefined;
    }
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
    const current = await currentWorkspace.read();
    if (params.assertCurrent?.() === false) {
      return undefined;
    }
    if (
      !sameGitHubPublicationWorkspace(workspace, current) ||
      !matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity })
    ) {
      return undefined;
    }
    const token = identity.env.GH_TOKEN;
    if (!token) {
      return undefined;
    }
    const githubHost = identity.host ?? GITHUB_PUBLIC_HOST;
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
      ...(githubHost !== GITHUB_PUBLIC_HOST ? { host: githubHost } : {}),
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

import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { resolveGitHubApiBaseUrl, resolveGitHubHost } from "../../agents/github-host-runtime.js";
import {
  GitHubCredentialLookupError,
  GitHubIdentityError,
} from "../../agents/github-read-identity.js";
import {
  resolveConfiguredGitHubToolIdentity,
  onManagedGitHubProfileChanged,
  prepareGitHubReadIdentity,
} from "../../agents/github-tool-identity.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { registerConfigWriteListener } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import {
  onUserProfileEmailBindingChanged,
  onUserProfilesChanged,
} from "../../state/user-profile-events.js";
import {
  getUserProfileDisplay,
  prepareUserProfileIdentity,
} from "../../state/user-profile-list.js";
import { parseWorkerGitHubLaunchBinding } from "../../worker/launch-descriptor.js";
import { requestCurrentGitHubOAuthRefresh } from "../github-oauth-lifecycle.js";
import {
  currentGitHubPublicationConfig,
  factoryPublicationNativeReader,
  factoryPublicationPreflightCredential,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  prepareGitHubPublicationWorkspaceOwner,
  prepareGitHubPublicationAvailability,
  prepareGitHubPullRequestReadAvailability,
  sameGitHubPublicationWorkspace,
} from "../github-publication-availability.js";
import { parseGitHubRemoteUrl } from "../github-remote.js";
import type { WorkerGitHubBindingGrant } from "./worker-github-binding-contract.js";
import { createWorkerGitHubBindingGrant } from "./worker-github-grant.js";
export { revokeWorkerGitHubBindingGrant } from "./worker-github-grant.js";

export type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "./worker-github-binding-contract.js";

type WorkerGitHubPreparationParams = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent?: () => boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  signal?: AbortSignal;
};

type PreparedWorkerTurnGitHub = {
  grant?: WorkerGitHubBindingGrant;
  githubPublicationAvailable: boolean;
  githubPullRequestReadAvailable: boolean;
};

/** The shipped SDK entry point retains fresh execution grants without discovery work. */
export async function prepareWorkerGitHubBindingGrant(
  params: WorkerGitHubPreparationParams,
): Promise<WorkerGitHubBindingGrant | undefined> {
  return (await prepareWorkerGitHub(params, false))?.grant;
}

/** One turn preparation; execution and discovery share only equivalent selected identity facts. */
export async function prepareWorkerTurnGitHub(
  params: WorkerGitHubPreparationParams,
): Promise<PreparedWorkerTurnGitHub> {
  return (
    (await prepareWorkerGitHub(params, true)) ?? {
      githubPublicationAvailable: false,
      githubPullRequestReadAvailable: false,
    }
  );
}

async function prepareWorkerGitHub(
  params: WorkerGitHubPreparationParams,
  discover: boolean,
): Promise<PreparedWorkerTurnGitHub | undefined> {
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
  if (process.env.FACTORY_AUTH_MODE === "github" && !operator) {
    const error = new Error("Worker GitHub execution requires the verified operator and session.");
    const origin =
      [
        "prepareLocalGitHubEnvironment",
        "startWorkerCodexAppServerClient",
        "ensureCodexSandboxExecServerEnvironment",
        "executeWorkerTurn",
      ].find((name) => error.stack?.includes(name)) ?? "unknown";
    createSubsystemLogger("gateway/worker-github").warn("worker_github_operator_unavailable", {
      origin,
      explicitOperator: Boolean(params.operatorAuthority),
      ambientCaller: Boolean(caller),
      ambientOperator: Boolean(caller?.operatorAuthority),
      agentMatch: caller?.agentId === params.agentId,
      keyMatch: caller?.sessionKey === params.sessionKey,
    });
    throw error;
  }
  let authorProfile: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  let retainedProfile = false;
  const startedAt = performance.now();
  let workspaceMs: number | undefined;
  let identityMs: number | undefined;
  let status: "ready" | "unavailable" | "failed" = "failed";
  try {
    const controller = new AbortController();
    const signal = AbortSignal.any(
      [params.signal, operator?.signal, controller.signal].filter(
        (candidate): candidate is AbortSignal => candidate !== undefined,
      ),
    );
    const preparedWorkspace = await prepareGitHubPublicationWorkspaceOwner(params, {
      allowMissingWorkspace: true,
    });
    workspaceMs = performance.now() - startedAt;
    const readWorkspace = preparedWorkspace.current;
    signal.throwIfAborted();
    operator?.assertCurrent();
    if (params.assertCurrent?.() === false) {
      return undefined;
    }
    const workspace = preparedWorkspace.initial;
    const authorBindingIds: readonly string[] =
      operator && process.env.FACTORY_AUTH_MODE === "github"
        ? (authorProfile = await prepareUserProfileIdentity(operator.profileId)).emailBindingIds
        : [];
    const assertAuthority = () => {
      signal.throwIfAborted();
      operator?.assertCurrent();
      authorProfile?.readCurrentFacts(authorBindingIds);
      if (
        params.assertCurrent?.() === false ||
        !sameGitHubPublicationWorkspace(workspace, readWorkspace())
      ) {
        throw new Error("Worker GitHub credential authority closed");
      }
    };
    assertAuthority();
    const prepareIdentity = () =>
      prepareCurrentGitHubPublicationIdentity(
        params.agentId,
        operator
          ? {
              profileId: operator.profileId,
              sessionKey: params.sessionKey,
              assertCurrent: assertAuthority,
            }
          : undefined,
        factoryPublicationPreflightCredential({
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: workspace.loaded.canonicalKey,
          lifecycleRevision: workspace.loaded.entry.lifecycleRevision ?? null,
          assertCurrent: assertAuthority,
        }),
      );
    let identity: Awaited<ReturnType<typeof prepareCurrentGitHubPublicationIdentity>>;
    const identityStartedAt = performance.now();
    try {
      identity = await prepareIdentity();
      identityMs = performance.now() - identityStartedAt;
    } catch (error) {
      assertAuthority();
      if (
        error instanceof GitHubCredentialLookupError ||
        (error instanceof GitHubIdentityError && error.reason !== "unavailable")
      ) {
        throw error;
      }
      const config = currentGitHubPublicationConfig();
      if (
        process.env.FACTORY_AUTH_MODE === "github" ||
        (["agent", "system"] as const).some((scope) =>
          resolveConfiguredGitHubToolIdentity({ config, agentId: params.agentId, scope }),
        )
      ) {
        throw new Error(
          error instanceof GitHubIdentityError && error.reason === "unavailable"
            ? "The selected GitHub identity is unavailable; reconnect it in Settings before starting this turn."
            : "The selected GitHub identity could not be prepared; inspect the credential lookup error before retrying this turn.",
          { cause: error },
        );
      }
      status = "unavailable";
      return undefined;
    }
    const assertCurrent = () => {
      assertAuthority();
      if (!matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity })) {
        throw new Error("Selected GitHub identity changed; start a new turn.");
      }
    };
    assertCurrent();
    const originUrl =
      workspace.kind === "none"
        ? undefined
        : workspace.kind === "repository"
          ? workspace.workspace.url
          : (await managedWorktrees.resolveRepositoryIdentity(workspace.worktree.path)).originUrl;
    assertCurrent();
    const githubHost = identity.host ?? resolveGitHubHost();
    const remote = originUrl ? parseGitHubRemoteUrl(originUrl, githubHost) : undefined;
    const scope =
      identity.source === "agent-override"
        ? "agent"
        : identity.source === "system-configured"
          ? "system"
          : undefined;
    const currentWorkspace = await preparedWorkspace.read();
    assertCurrent();
    if (!sameGitHubPublicationWorkspace(workspace, currentWorkspace)) {
      throw new Error("Worker GitHub session changed during author preparation");
    }
    const configuredAuthor = scope
      ? resolveConfiguredGitHubToolIdentity({
          config: currentGitHubPublicationConfig(),
          agentId: params.agentId,
          scope,
        })?.gitAuthor
      : undefined;
    const authorEmail = authorProfile
      ?.readCurrentFacts(authorBindingIds)
      .profile.emails.find((value) => value.includes("@"));
    if (authorProfile && !authorEmail) {
      throw new Error(
        "The signed-in user needs a verified profile email before creating worker commits.",
      );
    }
    const gitAuthor =
      configuredAuthor ??
      (authorEmail && operator
        ? {
            name: getUserProfileDisplay(operator.profileId).displayName?.trim() || authorEmail,
            email: authorEmail,
          }
        : undefined);
    const binding = parseWorkerGitHubLaunchBinding({
      token: identity.env.GH_TOKEN,
      ...(identity.env.OPENCLAW_GITHUB_EXECUTION_KIND === "app-installation"
        ? { executionKind: "app-installation" }
        : {}),
      ...(githubHost === "github.com" ? {} : { host: githubHost }),
      login: identity.account.login,
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
    let profileRevision = 0;
    let preparedProfileRevision = 0;
    const refreshCredential = async () => {
      assertCurrent();
      let currentIdentity: typeof identity;
      let revision: number;
      do {
        revision = profileRevision;
        currentIdentity = await prepareIdentity();
        assertCurrent();
      } while (revision !== profileRevision);
      if (
        currentIdentity.host !== identity.host ||
        currentIdentity.source !== identity.source ||
        currentIdentity.profileId !== identity.profileId ||
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
    const githubPublicationAvailable =
      discover &&
      (await prepareGitHubPublicationAvailability(params, {
        workspace: preparedWorkspace,
        identity,
        assertCurrent,
      }));
    assertCurrent();
    const githubPullRequestReadAvailable =
      discover &&
      (await prepareGitHubPullRequestReadAvailability(
        {
          ...params,
          githubPublicationAvailable,
        },
        preparedWorkspace,
      ));
    assertCurrent();
    const grant = createWorkerGitHubBindingGrant({
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
      release: () => {
        authorProfile?.release();
        authorProfile = undefined;
      },
    });
    retainedProfile = true;
    status = "ready";
    return { grant, githubPublicationAvailable, githubPullRequestReadAvailable };
  } finally {
    try {
      createSubsystemLogger("gateway/worker-github").info("worker_github_preparation", {
        agentId: params.agentId,
        sessionId: params.sessionId,
        status,
        discovery: discover,
        workspaceMs: workspaceMs === undefined ? undefined : Math.round(workspaceMs),
        identityMs: identityMs === undefined ? undefined : Math.round(identityMs),
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } catch {
      // Diagnostics cannot change admission or leak the retained grant's cleanup.
    }
    if (!retainedProfile) {
      authorProfile?.release();
    }
  }
}

/** Bounded checkout/recovery reads retain their caller and selected account, not commit authority. */
export async function prepareWorkerRepositoryGitHubIdentity(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  readNativeCredential?: import("../../agents/github-credential-reader.js").GitHubCredentialReader;
}) {
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
  const factory = process.env.FACTORY_AUTH_MODE === "github";
  if (factory && !operator && !params.readNativeCredential) {
    throw new Error("Repository GitHub access requires the current Factory operator and session.");
  }
  const preparedWorkspace = await prepareGitHubPublicationWorkspaceOwner(params);
  const workspace = preparedWorkspace.initial;
  const readWorkspace = preparedWorkspace.current;
  const host = resolveGitHubHost();
  const apiBaseUrl = resolveGitHubApiBaseUrl();
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
    operator?.assertCurrent();
    if (
      !sameGitHubPublicationWorkspace(workspace, readWorkspace()) ||
      resolveGitHubHost() !== host ||
      resolveGitHubApiBaseUrl() !== apiBaseUrl
    ) {
      throw new Error("Repository GitHub authority changed during preparation.");
    }
  };
  assertCurrent();
  const actor = operator
    ? { profileId: operator.profileId, sessionKey: params.sessionKey, assertCurrent }
    : undefined;
  const readNativeCredential =
    params.readNativeCredential ??
    factoryPublicationNativeReader(
      actor,
      factoryPublicationPreflightCredential({
        ...params,
        lifecycleRevision: workspace.loaded.entry.lifecycleRevision ?? null,
        assertCurrent,
      }),
    );
  const config = currentGitHubPublicationConfig();
  const identity = await prepareGitHubReadIdentity({
    config,
    sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
    agentId: params.agentId,
    readNativeCredential,
    getCurrentConfig: currentGitHubPublicationConfig,
    assertActive: assertCurrent,
    refresh: () => requestCurrentGitHubOAuthRefresh(params.agentId),
    allowAnonymous: true,
  });
  assertCurrent();
  identity.assertSelected();
  if (factory && !identity.token) {
    throw new Error("The selected GitHub credential is unavailable; reconnect it in Settings.");
  }
  return identity;
}

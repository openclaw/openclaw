import { WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  onManagedGitHubProfileChanged,
  resolveConfiguredGitHubToolIdentity,
} from "../../agents/github-tool-identity.js";
import type { PreparedGitHubPublicationIdentity } from "../../agents/github-tool-identity.types.js";
import type { AgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { registerConfigWriteListener } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  onUserProfilesChanged,
  onUserProfileEmailBindingChanged,
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
  type PublicationSessionIdentity,
} from "../github-publication-availability.js";
import { parseGitHubRemoteUrl } from "../github-remote.js";
import { StaleWorkerBuildError } from "./admission.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import {
  bindWorkerTurnGitHubGrant,
  type WorkerTurnExecutionIdentityStore,
} from "./placement-turn-claim-events.js";
import type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "./worker-github-binding-contract.js";

function workspaceKey(
  workspace: Awaited<ReturnType<typeof prepareGitHubPublicationWorkspaceOwner>>["initial"],
): string {
  return JSON.stringify(
    workspace.kind === "repository"
      ? [
          workspace.kind,
          workspace.workspace.workspaceId,
          workspace.workspace.url,
          workspace.workspace.branch,
        ]
      : [
          workspace.kind,
          workspace.worktree.id,
          workspace.worktree.repoFingerprint,
          workspace.worktree.branch,
        ],
  );
}

export async function prepareGitHubPublicationFact(
  params: PublicationSessionIdentity & {
    assertCurrent?: () => boolean;
  },
): Promise<
  | {
      available: boolean;
      github?: WorkerGitHubLaunchBinding;
      identity?: PreparedGitHubPublicationIdentity;
      workspaceKey?: string;
    }
  | undefined
> {
  try {
    if (params.assertCurrent?.() === false) {
      return undefined;
    }
    const currentWorkspace = await prepareGitHubPublicationWorkspaceOwner(params);
    using _ = { [Symbol.dispose]: () => currentWorkspace.release() };
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
    return {
      available: Boolean(identity.env.GH_TOKEN),
      ...(binding ? { github: binding, identity, workspaceKey: workspaceKey(workspace) } : {}),
    };
  } catch {
    return undefined;
  }
}

const log = createSubsystemLogger("gateway/worker-github");

/** Discovery prepared the account off the turn path; admission binds only local live authority. */
export async function prepareWorkerGitHubBindingGrant(
  params: PublicationSessionIdentity & {
    github: WorkerGitHubLaunchBinding;
    identity: PreparedGitHubPublicationIdentity;
    workspaceKey: string;
    sessionTarget: AgentRunSessionTarget;
    signal: AbortSignal;
    assertCurrent: () => void;
  },
): Promise<WorkerGitHubBindingGrant> {
  const controller = new AbortController();
  const signal = AbortSignal.any([params.signal, controller.signal]);
  const assertRun = () => {
    signal.throwIfAborted();
    params.assertCurrent();
  };
  assertRun();
  if (
    params.identity.accessExpiresAtMs !== undefined &&
    params.identity.accessExpiresAtMs <= Date.now()
  ) {
    throw new Error("Prepared GitHub credential expired; retry after background refresh");
  }
  const workspace = await prepareGitHubPublicationWorkspaceOwner(params, {
    sessionTarget: params.sessionTarget,
    assertCurrent: assertRun,
  });
  const initial = workspace.initial;
  const branch = initial.kind === "repository" ? initial.workspace.branch : initial.worktree.branch;
  if (
    workspaceKey(initial) !== params.workspaceKey ||
    branch !== params.github.branch ||
    params.identity.env.GH_TOKEN !== params.github.token
  ) {
    workspace.release();
    throw new Error("Prepared GitHub workspace or identity changed");
  }
  let revision = 0;
  let preparedRevision = 0;
  let checkedAt = Date.now();
  let generation = 0;
  let pending: WorkerGitHubBindingRefresh | undefined;
  let currentToken = params.github.token;
  let expiresAt = params.identity.accessExpiresAtMs;
  let pendingWork: Promise<WorkerGitHubBindingRefresh | undefined> | undefined;
  let released = false;
  const stops: (() => void)[] = [];
  const revoke = async () => {
    if (released) {
      return;
    }
    released = true;
    signal.removeEventListener("abort", onAbort);
    stops.splice(0).forEach((stop) => stop());
    workspace.release();
    controller.abort(new Error("Worker GitHub credential authority closed"));
  };
  const onAbort = () => {
    void revoke();
  };
  const assertCurrent = () => {
    try {
      assertRun();
      if (
        !sameGitHubPublicationWorkspace(initial, workspace.current()) ||
        !matchesCurrentGitHubPublicationIdentity({
          agentId: params.agentId,
          identity: params.identity,
        })
      ) {
        throw new Error("Worker GitHub credential authority changed");
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  const changed = () => {
    try {
      assertCurrent();
    } catch {
      /* Abort owns cleanup. */
    }
  };
  try {
    signal.addEventListener("abort", onAbort, { once: true });
    stops.push(
      registerConfigWriteListener(changed),
      onUserProfilesChanged(changed),
      onUserProfileEmailBindingChanged(changed),
      onManagedGitHubProfileChanged(({ profileDir, kind }) => {
        if (profileDir === params.identity.env.GH_CONFIG_DIR) {
          if (kind === "removed") {
            controller.abort(new Error("Selected GitHub profile removed"));
          } else {
            revision++;
          }
        }
      }),
    );
    assertCurrent();
  } catch (error) {
    await revoke();
    throw error;
  }
  return {
    binding: params.github,
    signal,
    assertCurrent,
    revoke,
    refresh(installedGeneration) {
      pendingWork ??= (async () => {
        assertCurrent();
        if (pending && installedGeneration === pending.generation) {
          currentToken = pending.token;
          expiresAt = pending.expiresAtMs;
          pending = undefined;
        }
        if (pending?.expiresAtMs !== undefined && pending.expiresAtMs <= Date.now()) {
          pending = undefined;
        }
        if (
          Date.now() - checkedAt < 60_000 &&
          revision === preparedRevision &&
          (expiresAt === undefined || expiresAt > Date.now() + 60_000)
        ) {
          return pending;
        }
        const startedRevision = revision;
        const identity = await prepareCurrentGitHubPublicationIdentity(
          params.agentId,
          assertCurrent,
        );
        const current = await workspace.read();
        assertCurrent();
        if (
          !sameGitHubPublicationWorkspace(initial, current) ||
          identity.source !== params.identity.source ||
          identity.profileId !== params.identity.profileId ||
          identity.account.accountId !== params.identity.account.accountId ||
          identity.account.login.toLowerCase() !== params.identity.account.login.toLowerCase()
        ) {
          controller.abort(new Error("Selected GitHub account changed; start a new turn"));
          signal.throwIfAborted();
        }
        const token = identity.env.GH_TOKEN;
        if (
          !token ||
          (identity.accessExpiresAtMs !== undefined && identity.accessExpiresAtMs <= Date.now())
        ) {
          throw new Error("Selected GitHub credential expired or unavailable");
        }
        checkedAt = Date.now();
        preparedRevision = startedRevision;
        if (token !== (pending?.token ?? currentToken)) {
          pending = { generation: ++generation, token, expiresAtMs: identity.accessExpiresAtMs };
        }
        return pending;
      })()
        .catch((error: unknown) => {
          assertCurrent();
          if (expiresAt !== undefined && expiresAt <= Date.now()) {
            controller.abort(error);
            signal.throwIfAborted();
          }
          log.warn(
            "Worker GitHub renewal failed; retrying while the current credential remains usable.",
          );
          return pending;
        })
        .finally(() => {
          pendingWork = undefined;
        });
      return pendingWork;
    },
  };
}

/** Attach the background fact to this admitted turn without running identity discovery. */
export async function bindWorkerGitHubTurn(params: {
  session: PublicationSessionIdentity;
  fact: Awaited<ReturnType<typeof prepareGitHubPublicationFact>>;
  sessionTarget: AgentRunSessionTarget;
  store: WorkerTurnExecutionIdentityStore;
  claim: WorkerSessionTurnClaim;
  protocolFeatures: readonly string[];
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<WorkerGitHubBindingGrant | undefined> {
  const { github, identity, workspaceKey: expectedWorkspace } = params.fact ?? {};
  if (!github || !identity || !expectedWorkspace) {
    return undefined;
  }
  if (!params.protocolFeatures.includes(WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE)) {
    throw new StaleWorkerBuildError();
  }
  const preparing = prepareWorkerGitHubBindingGrant({
    ...params.session,
    github,
    identity,
    workspaceKey: expectedWorkspace,
    sessionTarget: params.sessionTarget,
    signal: params.signal,
    assertCurrent: params.assertCurrent,
  }).then((grant) => {
    if (params.signal.aborted) {
      void grant.revoke();
    }
    return grant;
  });
  const grant = await raceNodeWorkerOperation(preparing, params.signal);
  try {
    bindWorkerTurnGitHubGrant(params.store, params.claim, grant);
  } catch (error) {
    await grant.revoke();
    throw error;
  }
  return grant;
}

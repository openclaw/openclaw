import { isDeepStrictEqual } from "node:util";
import type { SessionGitHubActionParams } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { withWorktreeGitConfig } from "../agents/worktrees/checkout-git-config.js";
import { isEmptyWorktreeSource } from "../agents/worktrees/empty-source.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { sessionEntryCommitGuardOptions } from "../config/sessions/session-source-authority.js";
import type { SessionEntry, SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  prepareGitHubPublicationRepositoryIdentity,
  prepareGitHubPublicationSession,
} from "./github-publication-availability.js";
import { integrateManagedWorkspaceSource } from "./github-publication-base-refresh.js";
import { inspectOwnGitHubPullRequest } from "./github-publication-inspect.js";
import { assertExistingPullRequestWriteAccess } from "./github-publication-pr-preflight.js";
import { prepareGitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { resolveLocalWorkspaceOwner } from "./worker-environments/local-workspace-projection.js";
import type { LocalWorkspaceOwner } from "./worker-environments/local-workspace-types.js";

function samePullRequest(
  left: SessionGitHubPullRequestBinding,
  right: SessionGitHubPullRequestBinding,
) {
  return (
    left.host === right.host &&
    left.number === right.number &&
    left.base.repositoryId === right.base.repositoryId &&
    left.head.repositoryId === right.head.repositoryId &&
    left.head.branch === right.head.branch
  );
}

export async function performSessionGitHubPreparation(
  options: Omit<GatewayRequestHandlerOptions, "params"> & {
    params: Extract<SessionGitHubActionParams, { action: "prepare_pr" }>;
  },
): Promise<void> {
  const { params, context } = options;
  const caller = getGatewayToolCallerIdentity();
  const sandbox = caller?.workspaceBaseRefreshSandbox;
  if (
    !caller ||
    !sandbox?.enabled ||
    !sandbox.backend ||
    sandbox.workspaceSource !== "managed-worktree"
  ) {
    throw new Error(
      "Run prepare_pr from this conversation's sandboxed agent in a managed workspace.",
    );
  }
  if (sandbox.workspaceAccess === "ro") {
    throw new Error("The workspace is read-only; prepare_pr requires a writable sandbox.");
  }
  if (
    params.sessionKey !== caller.sessionKey ||
    (params.agentId && normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId))
  ) {
    throw new Error("PR preparation must use the current conversation's workspace.");
  }
  using selected = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: caller.agentId ?? params.agentId,
    assertCurrent: () => options.sessionMutationAuthorization?.assertCurrent(),
    // The worktree owner retains its binding; preparation itself writes the nested PR association.
    fields: [
      "sessionId",
      "lifecycleRevision",
      "archivedAt",
      "repositoryWorkspaceId",
      "owner",
      "createdActor",
      "visibility",
      "incognito",
    ],
  });
  const loaded = selected.readCurrent();
  if (!loaded.entry?.sessionId) {
    throw new Error("The PR preparation session is unavailable.");
  }
  const session = { agentId: loaded.agentId, sessionKey: loaded.canonicalKey };
  const admitted = await prepareGitHubPublicationRequesterV2(options, session);
  using _ = { [Symbol.dispose]: admitted.release };
  const assertSession = () => {
    options.signal?.throwIfAborted();
    selected.readCurrent();
    admitted.requester.assertCurrent();
  };
  using owner = await resolveLocalWorkspaceOwner({
    ...session,
    cfg: context.getRuntimeConfig(),
    assertCurrent: assertSession,
  });
  if (!owner) {
    throw new Error(
      "PR preparation requires this conversation's existing local managed workspace.",
    );
  }
  const placements = context.workerSessionPlacementService;
  if (!placements?.withWorkspaceExclusion) {
    throw new Error("Workspace coordination is unavailable; retry after Gateway startup.");
  }
  const result = await placements.withWorkspaceExclusion(
    loaded.entry.sessionId,
    async (assertOwned) => {
      const assertWorkspace = () => {
        assertSession();
        owner.assertCurrent();
        assertOwned();
      };
      const inspected = await inspectOwnGitHubPullRequest({
        pullRequestUrl: params.pullRequestUrl,
        agentId: session.agentId,
        requester: admitted.requester,
        assertCurrent: assertWorkspace,
      });
      const identity = await prepareCurrentGitHubPublicationIdentity(
        session.agentId,
        inspected.assertCurrent,
      );
      const assertCurrent = () => {
        assertWorkspace();
        inspected.assertCurrent();
        if (!matchesCurrentGitHubPublicationIdentity({ agentId: session.agentId, identity })) {
          throw new Error("The GitHub publisher changed; retry PR preparation.");
        }
      };
      await assertExistingPullRequestWriteAccess({
        pullRequest: inspected.result,
        identity,
        assertCurrent,
      });
      const { url, host, number, base, head } = inspected.result;
      if (!head) {
        throw new Error("The original PR head is unavailable; saved work was preserved.");
      }
      return await prepareManagedPullRequestWorkspace({
        owner,
        storePath: loaded.storePath,
        identity,
        sandbox,
        pullRequest: { url, host, number, base, head },
        assertCurrent,
        verifyCurrentPullRequest: async () => {
          await assertExistingPullRequestWriteAccess({
            pullRequest: inspected.result,
            identity,
            assertCurrent,
          });
        },
        signal: options.signal,
        conflictsResolved: params.conflictsResolved,
        baseCommit: params.expectedHeadCommit,
      });
    },
  );
  assertSession();
  options.respond(true, result);
}

/** The caller retains current PR eligibility and session-action exclusion through this operation. */
async function prepareManagedPullRequestWorkspace(params: {
  owner: LocalWorkspaceOwner;
  storePath: string;
  identity: PreparedGitHubPublicationIdentity;
  sandbox: SandboxContext;
  pullRequest: Omit<SessionGitHubPullRequestBinding, "preparedHeadCommit">;
  assertCurrent: () => void;
  verifyCurrentPullRequest: () => Promise<void>;
  signal?: AbortSignal;
  conflictsResolved?: boolean;
  baseCommit?: string;
}) {
  const { owner } = params;
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
    owner.assertCurrent();
  };
  const assertEntry = (entry: SessionEntry) => {
    assertCurrent();
    if (
      entry.sessionId !== owner.sessionId ||
      (entry.lifecycleRevision ?? null) !== owner.lifecycleRevision ||
      entry.archivedAt !== undefined ||
      entry.repositoryWorkspaceId ||
      entry.worktree?.id !== owner.worktree.id ||
      entry.worktree.branch !== owner.worktree.branch ||
      entry.worktree.repoRoot !== owner.worktree.repoRoot
    ) {
      throw new Error(
        "The conversation's workspace changed; retry preparation in its current workspace.",
      );
    }
    return entry.worktree;
  };
  assertCurrent();
  const emptySource = await isEmptyWorktreeSource({
    env: owner.env ?? process.env,
    ownerId: owner.sessionKey,
    repoRoot: owner.worktree.repoRoot,
    signal: params.signal,
    commitGuard: assertCurrent,
  });
  if (!emptySource) {
    const repository = await prepareGitHubPublicationRepositoryIdentity({
      worktree: owner.worktree,
      assertCurrent,
    });
    const origin = parseGitHubRemoteUrl(repository.originUrl, params.pullRequest.host);
    const name = origin && `${origin.owner}/${origin.repo}`.toLowerCase();
    if (
      !name ||
      ![params.pullRequest.base.repository, params.pullRequest.head.repository].some(
        (candidate) => candidate.toLowerCase() === name,
      )
    ) {
      throw new Error(
        "This workspace belongs to another repository. Its existing files and history were preserved.",
      );
    }
  }

  const scope = {
    agentId: owner.agentId,
    sessionKey: owner.sessionKey,
    storePath: params.storePath,
  };
  using initial = await prepareGitHubPublicationSession(owner.sessionKey, {
    agentId: owner.agentId,
    assertCurrent,
  });
  const initialEntry = initial.readCurrent().entry;
  if (!initialEntry) {
    throw new Error("The conversation disappeared before PR workspace preparation.");
  }
  const previous = assertEntry(initialEntry).githubPullRequest;
  if (previous && !samePullRequest(previous, params.pullRequest)) {
    throw new Error(
      "This workspace already continues another PR or head branch. Its original association and saved work were preserved.",
    );
  }
  if (!previous) {
    const merge = await withWorktreeGitConfig(
      owner.worktree.path,
      true,
      { beforeRun: assertCurrent },
      (git) =>
        git.run(owner.worktree.path, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], {
          beforeRun: assertCurrent,
        }),
    );
    if (merge.code !== 1) {
      throw new Error(
        "Workspace base integration is pending or unavailable. Finish refresh_base before preparing a PR; saved work was preserved.",
      );
    }
  }
  if (
    previous &&
    previous.preparedHeadCommit === previous.head.commit &&
    previous.preparedHeadCommit === params.pullRequest.head.commit
  ) {
    const reviewBase = await withWorktreeGitConfig(
      owner.worktree.path,
      true,
      { beforeRun: assertCurrent },
      (git) =>
        git.require(
          owner.worktree.path,
          ["merge-base", previous.head.commit, previous.base.commit],
          { beforeRun: assertCurrent },
        ),
    );
    initial.readCurrent();
    return {
      status: "prepared" as const,
      url: previous.url,
      headCommit: previous.preparedHeadCommit,
      headChanged: false,
      changedPaths: [],
      conflictPaths: [],
      review: { mode: "local" as const, base: reviewBase },
    };
  }
  // Finish the accepted source before admitting another head, including after a restart.
  const binding: SessionGitHubPullRequestBinding =
    previous && previous.preparedHeadCommit !== previous.head.commit
      ? previous
      : {
          ...structuredClone(params.pullRequest),
          ...(previous?.preparedHeadCommit
            ? { preparedHeadCommit: previous.preparedHeadCommit }
            : {}),
        };
  using resources = new DisposableStack();
  let reserved: Awaited<ReturnType<typeof prepareGitHubPublicationSession>> | undefined;
  const assertReserved = () => {
    assertCurrent();
    const entry = (reserved ?? initial).readCurrent().entry;
    if (
      !entry ||
      !isDeepStrictEqual(assertEntry(entry).githubPullRequest, reserved ? binding : previous)
    ) {
      throw new Error("The accepted PR source changed; saved work was preserved.");
    }
  };
  const accept = async () => {
    if (previous?.preparedHeadCommit) {
      // Source fetches can outlive a remote head or permission observation.
      await params.verifyCurrentPullRequest();
    }
    assertReserved();
    const selected = await patchSessionEntryCore(
      scope,
      (entry) => {
        assertReserved();
        const worktree = assertEntry(entry);
        return { worktree: { ...worktree, githubPullRequest: binding } };
      },
      {
        ...sessionEntryCommitGuardOptions(assertReserved),
        requireWriteSuccess: true,
        skipMaintenance: true,
        preserveActivity: true,
      },
    );
    if (!selected) {
      throw new Error("The conversation disappeared before PR workspace preparation.");
    }
    reserved = resources.use(
      await prepareGitHubPublicationSession(owner.sessionKey, {
        agentId: owner.agentId,
        assertCurrent,
      }),
    );
    assertReserved();
  };
  assertReserved();
  const integration = await integrateManagedWorkspaceSource({
    owner,
    identity: params.identity,
    sandbox: params.sandbox,
    signal: params.signal,
    assertCurrent: assertReserved,
    conflictsResolved: params.conflictsResolved,
    baseCommit: params.baseCommit,
    source: {
      repository: binding.head.repository,
      branch: binding.head.branch,
      commit: binding.head.commit,
      githubHost: binding.host,
      review: { repository: binding.base.repository, commit: binding.base.commit },
      initial: binding.preparedHeadCommit === undefined,
      emptySource,
      resuming: previous !== undefined && previous.preparedHeadCommit !== previous.head.commit,
      accept,
    },
  });
  assertReserved();
  if (integration.status !== "conflicts") {
    await patchSessionEntryCore(
      scope,
      (entry) => {
        const worktree = assertEntry(entry);
        if (!isDeepStrictEqual(worktree.githubPullRequest, binding)) {
          throw new Error("The accepted PR source changed before preparation completed.");
        }
        return {
          worktree: {
            ...worktree,
            githubPullRequest: { ...binding, preparedHeadCommit: binding.head.commit },
          },
        };
      },
      {
        ...sessionEntryCommitGuardOptions(assertReserved),
        requireWriteSuccess: true,
        skipMaintenance: true,
        preserveActivity: true,
      },
    );
  }
  assertCurrent();
  return {
    status: integration.status === "conflicts" ? ("conflicts" as const) : ("prepared" as const),
    url: binding.url,
    headCommit: binding.head.commit,
    headChanged: binding.head.commit !== params.pullRequest.head.commit,
    changedPaths: integration.changedPaths,
    conflictPaths: integration.conflictPaths,
    ...(integration.review ? { review: integration.review } : {}),
  };
}

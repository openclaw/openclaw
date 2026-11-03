import { isDeepStrictEqual } from "node:util";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { canPrepareRepositoryWorkspace } from "../agents/sandbox/github-publication.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { withWorktreeGitConfig } from "../agents/worktrees/checkout-git-config.js";
import { isEmptyWorktreeSource } from "../agents/worktrees/empty-source.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { sessionEntryCommitGuardOptions } from "../config/sessions/session-source-authority.js";
import type { SessionEntry, SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  prepareGitHubPublicationRepositoryIdentity,
  prepareGitHubPublicationSession,
} from "./github-publication-availability.js";
import { integrateManagedWorkspaceSource } from "./github-publication-base-refresh.js";
import { parseGitHubPublicationBaseBranch } from "./github-publication-base.js";
import { prepareOwnGitHubPullRequestReader } from "./github-publication-inspect-reader.js";
import { captureGitHubPublicationActionAuthority } from "./github-publication-requester.js";
import { prepareManagedWorkspaceReviewBase } from "./github-publication-workspace-review.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import type {
  PullRequestPreparationInput,
  RepositoryPublicationProvider,
} from "./repository-publication-contract.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { isSessionOwnRequester } from "./session-sharing-policy.js";
import { resolveLocalWorkspaceOwner } from "./worker-environments/local-workspace-projection.js";

/** The conversation as preparation and adoption compare it, including its skills snapshot. */
export function preparePullRequestSession(
  sessionKey: string,
  options: { agentId?: string; assertCurrent: () => void },
) {
  return prepareGitHubPublicationSession(sessionKey, {
    ...options,
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
    // Adoption's file-source check selects skill libraries from the full entry.
    projection: ["skillsSnapshot"],
  });
}

export async function performSessionGitHubPreparation(
  options: PullRequestPreparationInput,
  provider: RepositoryPublicationProvider,
  context: GatewayRequestContext,
) {
  const { params } = options;
  const refreshingBase = params.action === "refresh_base";
  const caller = getGatewayToolCallerIdentity();
  let sandbox = caller?.workspaceBaseRefreshSandbox;
  const adopting = sandbox?.workspaceSource !== "managed-worktree";
  if (
    !caller ||
    !canPrepareRepositoryWorkspace(sandbox) ||
    (adopting && (!caller.workspacePrAdoptionSessionId || refreshingBase))
  ) {
    throw new Error(
      sandbox?.workspaceAccess === "ro"
        ? "The workspace is read-only; prepare_pr requires a writable sandbox."
        : "Run prepare_pr from this conversation's sandboxed agent in a managed workspace.",
    );
  }
  if (
    params.sessionKey !== caller.sessionKey ||
    (params.agentId && normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId))
  ) {
    throw new Error("PR preparation must use the current conversation's workspace.");
  }
  // The conversation as preparation and adoption compare it, including its skills snapshot.
  using selected = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: caller.agentId ?? params.agentId,
    assertCurrent: () => options.requester.assertCurrent(),
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
    // Adoption selects skill libraries from the full entry.
    projection: ["skillsSnapshot"],
  });
  const loaded = selected.readCurrent();
  if (!loaded.entry?.sessionId) {
    throw new Error("The PR preparation session is unavailable.");
  }
  const pullRequestUrl =
    params.action === "prepare_pr"
      ? params.pullRequestUrl
      : loaded.entry.worktree?.githubPullRequest?.url;
  if (!pullRequestUrl) {
    throw new Error("The PR association changed; retry refresh_base in its current workspace.");
  }
  const session = { agentId: loaded.agentId, sessionKey: loaded.canonicalKey };
  const publicationSession = { ...session, sessionId: loaded.entry.sessionId };
  const admitted = { requester: options.requester };
  const { getPluginRuntimeGatewayRequestScope } =
    await import("../plugins/runtime/gateway-request-scope.js");
  const client = getPluginRuntimeGatewayRequestScope()?.client ?? null;
  const authority = captureGitHubPublicationActionAuthority(admitted.requester);
  // Guests prepare their own conversation; a current full-write maintainer may assist.
  const { actor } = admitted.requester.snapshot;
  if (
    !authority.operatorWrite &&
    !isSessionOwnRequester(
      { cfg: context.getRuntimeConfig(), client },
      { canonicalKey: loaded.canonicalKey, entry: loaded.entry },
      actor.kind === "operator" && actor.profileId !== GATEWAY_OWNER_PROFILE_ID
        ? actor.profileId
        : undefined,
    )
  ) {
    throw new Error(
      "Only the person who started this conversation can prepare a PR in it without full operator write permission. Assigning a new owner does not transfer this.",
    );
  }
  const assertSession = () => {
    options.signal?.throwIfAborted();
    selected.readCurrent();
    authority.assertCurrent();
  };
  if (adopting && caller.workspacePrAdoptionSessionId !== loaded.entry.sessionId) {
    throw new Error("The conversation changed before PR preparation handoff.");
  }
  const placements = context.workerSessionPlacementService;
  if (
    !placements?.withWorkspaceExclusion ||
    (adopting && !placements.withLocalWorkspaceReservation)
  ) {
    throw new Error("Workspace coordination is unavailable; retry after Gateway startup.");
  }
  const inspectCurrent = async (assertWorkspace: () => void) => {
    const inspected = await provider.inspectPullRequest({
      pullRequestUrl,
      agentId: session.agentId,
      reader: await prepareOwnGitHubPullRequestReader(admitted.requester, publicationSession),
      assertCurrent: assertWorkspace,
    });
    await inspected.verifyWriteAccess();
    const publisher = await provider.preparePublisher(session.agentId);
    const assertCurrent = () => {
      inspected.assertCurrent();
      publisher.assertCurrent();
      assertWorkspace();
    };
    assertCurrent();
    return { inspected, publisher, assertCurrent };
  };
  const prepare = async (assertOwned: () => void) => {
    const assertPlacement = () => {
      assertSession();
      assertOwned();
    };
    using resources = new DisposableStack();
    if (adopting) {
      const [{ adoptUnboundPullRequestWorkspace }, { resolveSandboxContext }] = await Promise.all([
        import("./session-pr-workspace-adoption.js"),
        import("../agents/sandbox/context.js"),
      ]);
      // Allocation and the later source import each observe current GitHub eligibility.
      const eligibility = await inspectCurrent(assertPlacement);
      const entry = await adoptUnboundPullRequestWorkspace({
        context,
        target: { ...session, storePath: loaded.storePath },
        entry: loaded.entry!,
        sandbox: sandbox!,
        assertCurrent: eligibility.assertCurrent,
        verifyBeforeBinding: async () => {
          await eligibility.inspected.verifyWriteAccess();
        },
        signal: options.signal,
      });
      assertPlacement();
      const preparedSandbox = await resolveSandboxContext({
        config: context.getRuntimeConfig(),
        ...session,
        workspaceDir: entry.spawnedCwd,
        skillsSnapshot: entry.skillsSnapshot,
        assertCurrent: assertPlacement,
      });
      if (!preparedSandbox?.enabled || preparedSandbox.workspaceSource !== "managed-worktree") {
        preparedSandbox?.[Symbol.dispose]?.();
        throw new Error(
          "The PR workspace was saved, but its sandbox is not ready. Retry prepare_pr in this conversation.",
        );
      }
      sandbox = preparedSandbox;
      resources.defer(() => preparedSandbox[Symbol.dispose]?.());
    }
    using owner = await resolveLocalWorkspaceOwner({
      ...session,
      cfg: context.getRuntimeConfig(),
      assertCurrent: assertPlacement,
    });
    if (!owner) {
      throw new Error(
        "PR preparation requires this conversation's existing local managed workspace.",
      );
    }
    const { inspected, publisher, assertCurrent } = await inspectCurrent(owner.assertCurrent);
    const { url, host, number, base, head } = inspected.result;
    if (!head) {
      throw new Error("The original PR head is unavailable; saved work was preserved.");
    }
    const storePath = loaded.storePath;
    const publicationSandbox = sandbox!;
    const pullRequest = { url, host, number, base, head };
    const signal = options.signal;
    const conflictsResolved = params.conflictsResolved;
    const baseCommit =
      params.action === "prepare_pr" ? params.expectedHeadCommit : params.baseCommit;
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
      signal,
      commitGuard: assertCurrent,
    });
    let projectBase: { repository: string; branch: string } | undefined;
    if (!emptySource) {
      const repository = await prepareGitHubPublicationRepositoryIdentity({
        worktree: owner.worktree,
        assertCurrent,
      });
      const origin = parseGitHubRemoteUrl(repository.originUrl, pullRequest.host);
      const name = origin && `${origin.owner}/${origin.repo}`.toLowerCase();
      if (
        !name ||
        ![pullRequest.base.repository, pullRequest.head.repository].some(
          (candidate) => candidate.toLowerCase() === name,
        )
      ) {
        throw new Error(
          "This workspace belongs to another repository. Its existing files and history were preserved.",
        );
      }
      const branch = parseGitHubPublicationBaseBranch(owner.worktree.baseRef, "");
      if (branch) {
        projectBase = { repository: name, branch };
      }
    }

    const scope = {
      agentId: owner.agentId,
      sessionKey: owner.sessionKey,
      storePath,
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
    // A PR this conversation published continues from its published head, so commits
    // another writer appended merge into the saved work like any advanced PR head.
    const preparedHead = previous ? previous.preparedHeadCommit : inspected.publishedHeadCommit;
    if (
      previous &&
      (previous.host !== pullRequest.host ||
        previous.number !== pullRequest.number ||
        previous.base.repositoryId !== pullRequest.base.repositoryId ||
        previous.head.repositoryId !== pullRequest.head.repositoryId ||
        previous.head.branch !== pullRequest.head.branch)
    ) {
      throw new Error(
        "This workspace already continues another PR or head branch. Its original association and saved work were preserved.",
      );
    }
    if (
      refreshingBase &&
      (!previous?.preparedHeadCommit || previous.preparedHeadCommit !== previous.head.commit)
    ) {
      throw new Error(
        "Finish prepare_pr for the accepted PR head before refreshing its base; saved work was preserved.",
      );
    }
    let pendingBase = false;
    if (!previous || previous.preparedHeadCommit === previous.head.commit) {
      const merge = await withWorktreeGitConfig(
        owner.worktree.path,
        true,
        { beforeRun: assertCurrent },
        (git) =>
          git.run(owner.worktree.path, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], {
            beforeRun: assertCurrent,
          }),
      );
      if (merge.code !== 1 && (!refreshingBase || merge.code !== 0)) {
        throw new Error(
          "Workspace base integration is pending or unavailable. Finish refresh_base before preparing a PR; saved work was preserved.",
        );
      }
      pendingBase = merge.code === 0;
    }
    if (
      !pendingBase &&
      (refreshingBase ||
        (previous?.base.branch === pullRequest.base.branch &&
          previous.base.commit !== pullRequest.base.commit))
    ) {
      // PR details can lag the live ref, including after a completed base refresh.
      const baseUrl = `https://${pullRequest.host}/${pullRequest.base.repository}.git`;
      pullRequest.base = {
        ...pullRequest.base,
        commit: await provider.readBase({
          target: {
            pushRepository: pullRequest.head.repository,
            repository: pullRequest.base.repository,
            branch: pullRequest.head.branch,
            baseBranch: pullRequest.base.branch,
            remoteUrl: `https://${pullRequest.host}/${pullRequest.head.repository}.git`,
            baseRemoteUrl: baseUrl,
          },
          publisher,
          assertCurrent,
        }),
      };
    }
    if (
      !refreshingBase &&
      previous &&
      previous.preparedHeadCommit === previous.head.commit &&
      previous.preparedHeadCommit === pullRequest.head.commit &&
      previous.base.branch === pullRequest.base.branch &&
      previous.base.commit === pullRequest.base.commit
    ) {
      const reviewBase = await withWorktreeGitConfig(
        owner.worktree.path,
        true,
        { beforeRun: assertCurrent },
        (git) =>
          git.require(owner.worktree.path, ["merge-base", "HEAD", previous.base.commit], {
            beforeRun: assertCurrent,
          }),
      );
      // A failed destination adoption may have prepared its review ref before the
      // binding write. Repair that projection without restaging any guest work.
      const review = await prepareManagedWorkspaceReviewBase({
        owner,
        sandbox: publicationSandbox,
        reviewCommit: reviewBase,
        signal,
        assertCurrent,
        stageChanges: false,
        reviewPreparationError: "The PR review base could not be prepared; retry prepare_pr.",
      });
      initial.readCurrent();
      return {
        status: "prepared" as const,
        url: previous.url,
        headCommit: previous.preparedHeadCommit,
        headChanged: false,
        changedPaths: [],
        conflictPaths: [],
        review,
      };
    }
    // Refresh keeps the first association's origin, including legacy absence.
    const origin = previous
      ? previous.origin
      : inspected.ownPublication
        ? "session-publication"
        : "external-pr";
    // Finish the accepted source before admitting another head, including after a restart.
    const binding: SessionGitHubPullRequestBinding =
      refreshingBase && previous
        ? {
            ...previous,
            // A retry finishes its accepted base before selecting a newer destination.
            base: pendingBase ? previous.base : structuredClone(pullRequest.base),
          }
        : previous && previous.preparedHeadCommit !== previous.head.commit
          ? { ...previous, base: structuredClone(pullRequest.base) }
          : {
              ...structuredClone(pullRequest),
              ...(origin ? { origin } : {}),
              ...(preparedHead ? { preparedHeadCommit: preparedHead } : {}),
            };
    const reviewOnly = !refreshingBase && preparedHead === binding.head.commit;
    using sourceResources = new DisposableStack();
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
      if (preparedHead) {
        // Source fetches can outlive a remote head or permission observation.
        await inspected.verifyWriteAccess();
      }
      assertReserved();
      const committedEntry = await patchSessionEntryCore(
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
      if (!committedEntry) {
        throw new Error("The conversation disappeared before PR workspace preparation.");
      }
      reserved = sourceResources.use(
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
      provider,
      publisher,
      sandbox: publicationSandbox,
      signal,
      assertCurrent: assertReserved,
      conflictsResolved,
      baseCommit,
      ...(refreshingBase
        ? {
            verifiedBase: {
              repository: binding.base.repository,
              branch: binding.base.branch,
              commit: binding.base.commit,
              githubHost: binding.host,
              resuming: pendingBase,
              accept,
            },
          }
        : {
            source: {
              repository: binding.head.repository,
              branch: binding.head.branch,
              commit: binding.head.commit,
              githubHost: binding.host,
              review: { repository: binding.base.repository, commit: binding.base.commit },
              projectBase,
              initial: binding.preparedHeadCommit === undefined,
              reviewOnly,
              emptySource,
              resuming:
                previous !== undefined && previous.preparedHeadCommit !== previous.head.commit,
              accept,
            },
          }),
    });
    assertReserved();
    if (refreshingBase) {
      return integration;
    }
    if (integration.status !== "conflicts" && !reviewOnly) {
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
      headChanged: binding.head.commit !== pullRequest.head.commit,
      changedPaths: integration.changedPaths,
      conflictPaths: integration.conflictPaths,
      ...(integration.review ? { review: integration.review } : {}),
    };
  };
  let result: Awaited<ReturnType<typeof prepare>>;
  if (adopting) {
    if (!placements.withLocalWorkspaceReservation) {
      throw new Error("Workspace coordination is unavailable; retry after Gateway startup.");
    }
    result = await placements.withLocalWorkspaceReservation(
      { ...session, sessionId: loaded.entry.sessionId },
      prepare,
    );
  } else {
    result = await placements.withWorkspaceExclusion(loaded.entry.sessionId, prepare);
  }
  assertSession();
  return result;
}

import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isAbortError } from "../infra/abort-signal.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import { prepareWorkspacePublicationContent } from "./github-publication-content.js";
import {
  RepositoryPublicationProviderUnavailableError,
  RepositoryPublicationAuthorityLostError,
  RepositoryPublicationFailureError,
  RepositoryPublicationRequesterUnavailableError,
  RepositoryPublicationWorkspaceChangedError,
} from "./github-publication-errors.js";
import {
  GitHubPublicationRecoveryPendingError,
  assertGitHubPublicationRefCasCompleted,
  updateGitHubPublicationBranchAndIndex,
} from "./github-publication-git-index.js";
import {
  assertSafeGitPublicationWorkspace,
  assertGitHubPublicationBranchRef,
  captureGitHubPublicationWorkspaceSnapshot,
  createGitHubPublicationCommandRunner,
  readGitHubPublicationCoauthorTrailers,
  githubPublicationUpdateRefArgs,
  requirePublicationCommand as requireCommand,
  runPublicationCommand as runCommand,
  readGitHubPublicationTree,
  githubPublicationPushArgs,
  runAuthorizedPublicationGit,
  requireGitHubPublicationCommit,
} from "./github-publication-git-transport.js";
import { prepareOwnGitHubPullRequestReader } from "./github-publication-inspect-reader.js";
import { createExecutionPublisher } from "./github-publication-policy.js";
import { projectGitHubPublicationResult, requestFacts } from "./github-publication-receipt.js";
import {
  reconcileGitHubPublication,
  prepareGitHubPublicationWorkspaceRecovery,
  type GitHubPublicationRecoveryResult,
} from "./github-publication-recovery.js";
import type { GitHubPublicationRequesterPolicyV2 } from "./github-publication-requester.js";
import { readSharedGitHubPublication } from "./github-publication-shared-read.js";
import { prepareGitHubPublicationExecutionTarget } from "./github-publication-target.js";
import { GatewayOperatorAccessUnavailableError } from "./operator-access-policy.js";
import type {
  RepositoryPublicationProvider,
  RepositoryPublicationPublisher,
} from "./repository-publication-contract.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

const PUBLICATION_MARKER = "OpenClaw-Publication";

export async function executeGitHubPublication<Row extends GitHubPublicationExecutionRow>(params: {
  initial: Row;
  config: OpenClawConfig;
  provider: RepositoryPublicationProvider;
  publisher?: () => Promise<RepositoryPublicationPublisher>;
  recoveryResult?: GitHubPublicationRecoveryResult;
  requester?: () => GitHubPublicationRequesterPolicyV2;
  target?: { pushRepository: string; repository: string; baseBranch: string };
  recordEffect?: (
    effect: "push" | "pull_request",
    observed?: { headCommit?: string; url?: string },
  ) => void | Promise<void>;
  validateAuthority: () => boolean;
  prepareAuthority?: () => Promise<void>;
  requesterProfileId?: () => string | undefined;
  validateCustody: () => boolean;
  assertWorkflowChangesAllowed: () => void;
  bindWorkspaceSnapshot: (input: {
    row: Row;
    sourceHeadCommit: string;
    sourceIndexTree: string;
    workspaceTree: string;
  }) => Row | Promise<Row>;
  updatePublishingFacts: (input: {
    row: Row;
    repository: string;
    branch: string;
    baseBranch: string;
    sourceHeadCommit: string;
    workspaceTree: string;
    headCommit: string;
  }) => Row | Promise<Row>;
  complete: (row: Row, result: SessionGitHubPublicationResult) => Row | Promise<Row>;
  defer?: (row: Row) => Row | Promise<Row>;
  interrupt?: () => Row | Promise<Row>;
}): Promise<SessionGitHubPublicationResult> {
  const { initial } = params;
  if (initial.status === "published" || initial.status === "failed") {
    return projectGitHubPublicationResult(initial);
  }
  let pullRequestPending = false;
  // A confirmed push can still leave its pull-request outcome unknown.
  let effectDispatched = false;
  let row = initial;
  let worktreeOwner:
    | Awaited<ReturnType<typeof prepareGitHubPublicationWorkspaceRecovery>>
    | undefined;
  const currentWorktree = () => {
    if (!worktreeOwner) {
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication workspace authority could not be verified; retry recovery.",
      );
    }
    return worktreeOwner.assertCurrent();
  };
  const assertCustody = () => {
    if (!params.validateCustody()) {
      throw new RepositoryPublicationAuthorityLostError(
        "GitHub publication execution custody changed.",
      );
    }
    currentWorktree();
  };
  const custodyCommands = createGitHubPublicationCommandRunner(assertCustody);
  const { assertCurrent: assertAuthority, refreshIdentity } = createExecutionPublisher({
    row: initial,
    provider: params.provider,
    publisher: params.publisher,
    validateAuthority: params.validateAuthority,
    assertWorkspace: () => {
      currentWorktree();
    },
  });
  let bound:
    | Awaited<ReturnType<RepositoryPublicationProvider["prepareBoundPublication"]>>
    | undefined;
  const assertCurrent = () => {
    assertAuthority();
    bound?.assertCurrent();
  };
  const { step, run, require: command } = createGitHubPublicationCommandRunner(assertCurrent);
  const reconcileObservedPublication = async () => {
    const result = await reconcileGitHubPublication({
      initial: row,
      provider: params.provider,
      publisher: params.publisher,
      validateCustody: params.validateCustody,
      complete: params.complete,
      pushOnly: "observed",
    });
    if (!result) {
      throw new GitHubPublicationRecoveryPendingError(
        "The original PR update is unconfirmed; retry recovery before publishing again.",
      );
    }
    return result;
  };
  try {
    worktreeOwner = await prepareGitHubPublicationWorkspaceRecovery(params);
    const { loaded, worktree, recoveryResult } = worktreeOwner;
    if (recoveryResult) {
      return recoveryResult;
    }
    const pullRequest = loaded.entry.worktree?.githubPullRequest;
    // Accepted workspace recovery retains custody even when the requester can no longer publish.
    if (params.prepareAuthority) {
      await params.prepareAuthority();
    }
    let sourceHeadCommit = row.source_head_commit;
    let sourceIndexTree = row.source_index_tree;
    let workspaceTree = row.workspace_tree;
    if (!sourceHeadCommit || !sourceIndexTree || !workspaceTree) {
      const snapshot = await captureGitHubPublicationWorkspaceSnapshot({
        cwd: worktree.path,
        assertCurrent: assertAuthority,
      });
      row = await params.bindWorkspaceSnapshot({ row, ...snapshot });
      sourceHeadCommit = snapshot.sourceHeadCommit;
      sourceIndexTree = snapshot.sourceIndexTree;
      workspaceTree = snapshot.workspaceTree;
    }
    if (row.identity_source === "personal") {
      // Recover the request-owned index first. Confirmation must then validate the
      // live workspace inside this execution so a proven mismatch becomes its retained result.
      let snapshot;
      try {
        snapshot = await captureGitHubPublicationWorkspaceSnapshot({
          cwd: worktree.path,
          assertCurrent: assertAuthority,
        });
      } catch (error) {
        if (error instanceof RepositoryPublicationProviderUnavailableError) {
          throw new GitHubPublicationRecoveryPendingError(error.message, { cause: error });
        }
        if (isAbortError(error)) {
          throw error;
        }
        // Failed observation is not proof of drift; leave the original request reconfirmable.
        throw new GitHubPublicationRecoveryPendingError(
          "My GitHub workspace snapshot could not be verified; retry confirmation after local Git operations finish.",
          { cause: error },
        );
      }
      if (
        snapshot.workspaceTree !== workspaceTree ||
        (snapshot.sourceIndexTree !== sourceIndexTree && snapshot.sourceIndexTree !== workspaceTree)
      ) {
        throw new RepositoryPublicationWorkspaceChangedError(
          "GitHub publication workspace changed after its accepted snapshot.",
        );
      }
    }
    let identity = await refreshIdentity();
    if (pullRequest) {
      if (!params.requester || row.identity_source === "personal") {
        throw new RepositoryPublicationRequesterUnavailableError();
      }
      const published = await readSharedGitHubPublication(
        { agentId: row.agent_id, sessionKey: row.session_key, sessionId: row.session_id },
        { status: "published" },
      );
      assertCurrent();
      let expectedHead = pullRequest.head.commit;
      // Retargeting changes the comparison, not the head this session already published.
      if (
        published?.head_commit &&
        published.repository === pullRequest.base.repository &&
        published.branch === pullRequest.head.branch &&
        published.pull_request_url === pullRequest.url
      ) {
        const ancestry = await run(
          ["git", "merge-base", "--is-ancestor", expectedHead, published.head_commit],
          { cwd: worktree.path },
        );
        if (ancestry.code === 0) {
          expectedHead = published.head_commit;
        } else if (ancestry.code !== 1) {
          throw new GitHubPublicationRecoveryPendingError(
            "The accepted PR source and previous publication could not be compared; saved work was preserved.",
          );
        }
      }
      try {
        bound = await params.provider.prepareBoundPublication({
          pullRequest,
          expectedHead,
          journaledHead: row.head_commit,
          sourceHead: row.source_head_commit,
          agentId: row.agent_id,
          reader: await prepareOwnGitHubPullRequestReader(
            params.requester(),
            requestFacts(row).session,
          ),
          publisher: identity,
          assertCurrent: assertAuthority,
        });
      } catch (error) {
        if (
          params.provider.resolveFailure(error).code === "push_rejected" &&
          row.head_commit &&
          row.head_commit !== row.source_head_commit
        ) {
          const reconciled = await reconcileObservedPublication().catch((cause: unknown) => {
            if (cause instanceof GitHubPublicationRecoveryPendingError) {
              return undefined;
            }
            throw cause;
          });
          if (reconciled) {
            return reconciled;
          }
        }
        throw error;
      }
      if (bound.observedPublication) {
        return await reconcileObservedPublication();
      }
    }
    const preparation = await prepareGitHubPublicationExecutionTarget({
      worktree,
      publisher: identity,
      provider: params.provider,
      pullRequest,
      row,
      lifecycleRevision: loaded.entry.lifecycleRevision ?? null,
      expectedTarget: params.target,
      assertCurrent: assertAuthority,
    });
    if (preparation.status === "reconcile") {
      return await reconcileObservedPublication();
    }
    const { target } = preparation;
    const {
      pushRepository,
      repository,
      branch,
      baseBranch,
      remoteUrl,
      baseRemoteUrl,
      publishedPullRequest,
    } = target;
    const remoteBaseSha = await params.provider.readBase({
      target,
      publisher: identity,
      assertCurrent: assertAuthority,
    });
    await step(() => assertSafeGitPublicationWorkspace(worktree.path, runCommand));
    identity = await refreshIdentity();
    await requireGitHubPublicationCommit({
      publisher: identity,
      remoteUrl: baseRemoteUrl,
      sha: remoteBaseSha,
      cwd: worktree.path,
      assertCurrent: assertAuthority,
      failure: "Publication workspace base could not be materialized.",
    });
    // Reflogs can expire or restart when a branch is recreated; commits own its history.
    const lineage = await run(["git", "merge-base", sourceHeadCommit, remoteBaseSha], {
      cwd: worktree.path,
    });
    if (lineage.code === 1) {
      throw new RepositoryPublicationFailureError("GitHub publication histories are unrelated.", {
        code: "workspace_changed",
        nextAction:
          "The accepted commit and pull request base have no shared Git history. Preserve your work and apply the intended changes to a session branch based on the target repository before publishing again.",
      });
    }
    if (lineage.code !== 0) {
      throw new Error("GitHub publication workspace base lineage could not be verified.");
    }
    const baseTree = await command(["git", "rev-parse", `${remoteBaseSha}^{tree}`], {
      cwd: worktree.path,
    });
    // An existing PR may append a complete revert of its original contribution.
    if (!pullRequest && baseTree === workspaceTree) {
      throw new RepositoryPublicationFailureError("GitHub publication has no changes to publish.", {
        code: "no_changes",
        nextAction: "Make or restore a repository change, then retry.",
      });
    }
    const marker = `${PUBLICATION_MARKER}: ${row.request_id}`;
    const head = await command(
      ["git", "show", "-s", "--no-show-signature", "--format=%H%n%T%n%P%n%B", "HEAD"],
      {
        cwd: worktree.path,
      },
    );
    const [initialHead, currentTree, parents, ...message] = head.split("\n");
    let headCommit = initialHead!;
    const currentMessage = message.join("\n").trim();
    const findPullRequest = async () =>
      params.provider.findPullRequest({
        target,
        request: requestFacts(row),
        publisher: await refreshIdentity(),
        headCommit,
        workspaceTree,
        parentCommit: sourceHeadCommit,
        recordObserved: async (url) => {
          await params.recordEffect?.("pull_request", { url });
          pullRequestPending = false;
        },
        assertCurrent,
      });
    const messageLines = currentMessage.split(/\r?\n/u);
    const markerPresent = messageLines.includes(marker);
    if (markerPresent) {
      if (parents!.split(" ", 1)[0] !== sourceHeadCommit || currentTree !== workspaceTree) {
        throw new RepositoryPublicationWorkspaceChangedError(
          "GitHub publication workspace changed after its accepted snapshot.",
        );
      }
    }
    const sourceHeadChanged = !markerPresent && headCommit !== sourceHeadCommit;
    if (
      sourceHeadChanged &&
      (row.head_commit !== null ||
        row.identity_source === "personal" ||
        currentTree !== workspaceTree ||
        parents!.split(" ", 1)[0] !== sourceHeadCommit ||
        !messageLines.some((line) => line.startsWith(`${PUBLICATION_MARKER}: `)))
    ) {
      throw new RepositoryPublicationWorkspaceChangedError(
        "GitHub publication workspace changed after its accepted snapshot.",
      );
    }
    const observeRemoteHead = async () => {
      const observed =
        (await params.provider.observeBranch({
          target,
          publisher: await refreshIdentity(),
          assertCurrent: assertAuthority,
        })) ?? "";
      if (observed === headCommit) {
        await params.recordEffect?.("push", { headCommit });
      }
      return observed;
    };
    // Observe ancestry before creating bookkeeping commits or installing the accepted index.
    // Fetch objects only: do not move local refs, FETCH_HEAD, or the working tree.
    const expectedRemoteHead = await step(observeRemoteHead);
    let remoteHead = expectedRemoteHead;
    if (remoteHead && remoteHead !== headCommit) {
      await requireGitHubPublicationCommit({
        publisher: await refreshIdentity(),
        remoteUrl,
        sha: remoteHead,
        cwd: worktree.path,
        assertCurrent: assertAuthority,
        failure: "Publication remote branch could not be verified.",
      });
      const ancestry = await run(["git", "merge-base", "--is-ancestor", remoteHead, headCommit], {
        cwd: worktree.path,
      });
      if (ancestry.code === 1) {
        throw new RepositoryPublicationFailureError(
          "Publication cannot safely extend the published branch.",
          {
            code: "push_rejected",
            nextAction:
              "Preserve local work and inspect the published head. Apply changes on top of it or publish from a new session branch.",
          },
        );
      }
      if (ancestry.code !== 0) {
        throw new Error("GitHub publication remote branch could not be verified.");
      }
    }
    const existingPullRequest = await step(findPullRequest);
    const assertWorkflowAuthority = await params.provider.prepareChangeGuard({
      assertPermission: params.assertWorkflowChangesAllowed,
      readTree: async (role) => {
        const comparison = expectedRemoteHead || lineage.stdout.toString("utf8").trim();
        let selected: string;
        if (role === "accepted") {
          selected = workspaceTree;
        } else if (role === "before") {
          selected = comparison;
        } else if (role === "target") {
          selected = remoteBaseSha;
        } else {
          const result = await run(
            ["git", "merge-base", "--all", expectedRemoteHead || sourceHeadCommit, remoteBaseSha],
            { cwd: worktree.path },
          );
          if (result.code !== 0) {
            throw new Error("Publication ancestry could not be verified.");
          }
          const bases = result.stdout.toString("utf8").trim().split(/\s+/u);
          if (bases.length !== 1) {
            return undefined;
          }
          selected = bases[0]!;
        }
        return readGitHubPublicationTree(worktree.path, selected, run);
      },
    });
    const assertPublicationAction = () => {
      assertWorkflowAuthority();
      assertCurrent();
    };
    assertPublicationAction();
    const content = await prepareWorkspacePublicationContent(params.provider, {
      request: requestFacts(row),
      target,
      publisher: identity,
      requesterProfileId: params.requesterProfileId?.(),
      storePath: loaded.storePath,
      readCurrentEntry: () => currentWorktree().loaded.entry,
      assertCurrent: assertPublicationAction,
      config: params.config,
      marker,
      preparedMessage: markerPresent && remoteHead !== headCommit ? currentMessage : undefined,
    });
    const assertAction = content.assertCurrent;
    const completePublished = async (url: string, publishedHead: string) =>
      projectGitHubPublicationResult(
        await params.complete(row, {
          requestId: row.request_id,
          status: "published",
          url,
          repository,
          branch,
          headCommit: publishedHead,
        }),
      );
    let reusablePullRequest: string | undefined;
    if (
      existingPullRequest &&
      remoteHead === headCommit &&
      currentTree === workspaceTree &&
      (sourceIndexTree === workspaceTree ||
        (sourceHeadChanged &&
          (await command(["git", "write-tree"], { cwd: worktree.path })) === workspaceTree)) &&
      messageLines.some((line) => line.startsWith(`${PUBLICATION_MARKER}: `))
    ) {
      // Text in prose or an earlier paragraph is not Git co-author credit.
      // Parse the pinned commit before deciding its attributed tree can be reused.
      const trailers = await readGitHubPublicationCoauthorTrailers({
        cwd: worktree.path,
        headCommit,
        command,
      });
      assertAction();
      if (content.trailers.every((trailer) => trailers.includes(trailer))) {
        // The owned open PR already exposes this exact attributed tree. A new request
        // needs a receipt, not a new commit marker or index transaction. First publication
        // and missing contributor credit still use the request-owned recovery marker below.
        reusablePullRequest = existingPullRequest;
      }
    }
    // An earlier queued request can publish the exact frozen tree above. Otherwise,
    // a moved head still refuses before changing local history, the index, or GitHub.
    if (sourceHeadChanged && !reusablePullRequest) {
      throw new RepositoryPublicationWorkspaceChangedError(
        "GitHub publication workspace changed after its accepted snapshot.",
      );
    }
    row = await params.updatePublishingFacts({
      row,
      repository,
      branch,
      baseBranch,
      sourceHeadCommit,
      workspaceTree,
      headCommit,
    });
    if (reusablePullRequest) {
      return await completePublished(reusablePullRequest, headCommit);
    }
    const previousBranchHead = headCommit;
    let updateBranchRef: (() => Promise<void>) | undefined;
    if (!markerPresent) {
      await command(["git", "cat-file", "-e", `${workspaceTree}^{tree}`], {
        cwd: worktree.path,
      });
      const timestamp = new Date(row.created_at_ms).toISOString();
      identity = await refreshIdentity();
      const authorEnv = {
        GIT_AUTHOR_NAME: identity.author.name,
        GIT_COMMITTER_NAME: identity.author.name,
        GIT_AUTHOR_EMAIL: identity.author.email,
        GIT_COMMITTER_EMAIL: identity.author.email,
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_DATE: timestamp,
      };
      const commit = await requireCommand(
        ["git", "commit-tree", "--no-gpg-sign", workspaceTree, "-p", headCommit],
        {
          cwd: worktree.path,
          env: authorEnv,
          input: content.commitMessage,
          beforeRun: assertAction,
        },
      );
      assertAuthority();
      await assertGitHubPublicationBranchRef(
        worktree.branch,
        async (argv) => (await run(argv, { cwd: worktree.path })).code ?? -1,
      );
      const previousHead = headCommit;
      updateBranchRef = async () => {
        const result = await runCommand(
          githubPublicationUpdateRefArgs(worktree.branch, commit, previousHead),
          {
            cwd: worktree.path,
            beforeRun: assertAuthority,
          },
        );
        assertGitHubPublicationRefCasCompleted(result);
      };
      headCommit = commit;
    }
    await updateGitHubPublicationBranchAndIndex({
      cwd: worktree.path,
      requestId: row.request_id,
      branch: worktree.branch,
      previousHead: previousBranchHead,
      sourceIndexTree,
      workspaceTree,
      headCommit,
      env: {},
      assertCurrent: assertAuthority,
      assertCustody,
      run: custodyCommands.require,
      ...(updateBranchRef ? { updateRef: updateBranchRef } : {}),
    });
    row = await params.updatePublishingFacts({
      row,
      repository,
      branch,
      baseBranch,
      sourceHeadCommit,
      workspaceTree,
      headCommit,
    });

    await step(() => assertSafeGitPublicationWorkspace(worktree.path, runCommand));
    identity = await refreshIdentity();
    if (await bound?.refresh()) {
      return await reconcileObservedPublication();
    }
    remoteHead = await step(observeRemoteHead);
    if (remoteHead !== headCommit) {
      if (remoteHead !== expectedRemoteHead) {
        throw new RepositoryPublicationFailureError("Publication branch changed.", {
          code: "push_rejected",
          nextAction: "Inspect the published head before retrying.",
        });
      }
      assertAction();
      await params.recordEffect?.("push");
      effectDispatched = true;
      const pushed = await runAuthorizedPublicationGit(
        identity,
        remoteUrl,
        githubPublicationPushArgs(remoteUrl, headCommit, branch, expectedRemoteHead),
        { cwd: worktree.path },
        assertAction,
      );
      await params.recordEffect?.("push", pushed.code === 0 ? { headCommit } : {});
      assertAuthority();
      remoteHead = await step(observeRemoteHead);
      if (remoteHead !== headCommit) {
        if (
          remoteHead === expectedRemoteHead &&
          pushed.code !== 0 &&
          pushed.signal === null &&
          !pushed.killed
        ) {
          const login = identity.provenance.account.login;
          throw new RepositoryPublicationFailureError(
            `The push to ${pushRepository} was rejected.`,
            {
              code: "push_rejected",
              nextAction: `The remote rejected the push to ${pushRepository}. Nothing was pushed as @${login}. Give @${login} write access (or point the worktree's origin at a fork it owns) and check the repository's branch rules, then request publication again.`,
            },
          );
        }
        throw new Error("Publication push verification failed.");
      }
      await params.recordEffect?.("push", { headCommit });
    }
    if (pullRequest || publishedPullRequest) {
      return await reconcileObservedPublication();
    }
    let pullRequestUrl = await findPullRequest();
    if (!pullRequestUrl) {
      identity = await refreshIdentity();
      assertAction();
      await params.recordEffect?.("pull_request");
      pullRequestPending = true;
      effectDispatched = true;
      pullRequestUrl = await params.provider.createPullRequest({
        target,
        request: requestFacts(row),
        publisher: identity,
        headCommit,
        workspaceTree,
        parentCommit: sourceHeadCommit,
        content,
        assertCurrent: assertAction,
      });
      await params.recordEffect?.("pull_request", pullRequestUrl ? { url: pullRequestUrl } : {});
      if (!pullRequestUrl) {
        assertAuthority();
        pullRequestUrl = await findPullRequest();
      }
    }
    if (!pullRequestUrl) {
      throw new Error("Pull request creation was rejected.");
    }
    if (pullRequestPending) {
      await params.recordEffect?.("pull_request", { url: pullRequestUrl });
    }
    return await completePublished(pullRequestUrl, headCommit);
  } catch (error) {
    if (error instanceof RepositoryPublicationProviderUnavailableError) {
      throw new GitHubPublicationRecoveryPendingError(error.message, { cause: error });
    }
    if (
      isAbortError(error) ||
      error instanceof RepositoryPublicationRequesterUnavailableError ||
      error instanceof GatewayOperatorAccessUnavailableError
    ) {
      throw error;
    }
    if (error instanceof GitHubPublicationRecoveryPendingError) {
      throw error;
    }
    if (error instanceof RepositoryPublicationAuthorityLostError && params.defer) {
      return projectGitHubPublicationResult(await params.defer(initial));
    }
    if (
      params.interrupt &&
      (effectDispatched || initial.last_effect) &&
      !params.provider.isDefinitiveFailure(error)
    ) {
      // Unavailable observations cannot settle dispatched effects; only an owner's
      // definitive outcome ends recovery, retaining any already-recorded effects.
      assertAuthority();
      return projectGitHubPublicationResult(await params.interrupt());
    }
    // A head on entry belongs to an earlier attempt; current preparation updates row.
    // It can carry unconfirmed GitHub effects, not proof that a write was dispatched.
    // Shared recovery restores the original requester before attempting new actions.
    if (
      !params.interrupt &&
      (effectDispatched || initial.head_commit) &&
      !params.provider.isDefinitiveFailure(error)
    ) {
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication is unconfirmed; retry recovery before requesting another publication. Recorded effects are retained.",
        { cause: error },
      );
    }
    const failure = params.provider.resolveFailure(error);
    const result = projectGitHubPublicationResult(
      await params.complete(initial, {
        requestId: initial.request_id,
        status: "failed",
        code: failure.code,
        message: "GitHub publication failed.",
        nextAction: failure.nextAction,
      }),
    );
    if (error instanceof SessionMutationAuthorizationChangedError) {
      throw error;
    }
    return result;
  } finally {
    worktreeOwner?.release();
  }
}

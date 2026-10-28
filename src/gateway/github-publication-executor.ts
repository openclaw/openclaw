import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { githubRepositoryUrl } from "../agents/github-host.js";
import { isAbortError } from "../infra/abort-signal.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import { prepareGitHubPublicationContent } from "./github-publication-content.js";
import {
  createGitHubPublicationExecutionIdentity,
  GitHubPublicationAuthorityLostError,
  type GitHubPublicationIdentityOwner,
} from "./github-publication-execution-identity.js";
import {
  GitHubPublicationBranchChangedError,
  GitHubPublicationCreditChangedError,
  GitHubPublicationKnownFailure,
  GitHubPublicationRequesterUnavailableError,
  GitHubPublicationWorkspaceChangedError,
  gitHubPublicationPushFailure,
  resolveGitHubPublicationFailure,
} from "./github-publication-failure.js";
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
  githubPublicationApiArgs,
  githubPublicationPushArgs,
  githubPublicationRemoteHeadArgs,
  githubPublicationUpdateRefArgs,
  hasGitHubPublicationWorkflowChanges,
  hasGitHubPublicationMessageFooter,
  readGitHubPublicationCoauthorTrailers,
  readGitHubPublicationBaseSha,
  requireGitHubPublicationCommit,
  requirePublicationCommand as requireCommand,
  runPublicationCommand as runCommand,
} from "./github-publication-git-transport.js";
import {
  requestHeadFields,
  findGitHubPublicationPullRequest,
  reconcileGitHubPublicationPullRequest,
} from "./github-publication-pull-requests.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import {
  reconcileGitHubPublication,
  prepareGitHubPublicationWorkspaceRecovery,
} from "./github-publication-recovery.js";
import type { GitHubPublicationRequesterPolicyV2 } from "./github-publication-requester.js";
import {
  prepareBoundGitHubPublication,
  prepareGitHubPublicationTarget,
} from "./github-publication-target.js";
import { prepareGitHubPublicationWorkflowGuard } from "./github-publication-workflows.js";
import { GatewayOperatorAccessUnavailableError } from "./operator-access-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";

const PUBLICATION_MARKER = "OpenClaw-Publication";

type PublicationRow = GitHubPublicationExecutionRow;

export async function executeGitHubPublication<Row extends PublicationRow>(params: {
  initial: Row;
  recoveryResult?: SessionGitHubPublicationResult;
  identity?: GitHubPublicationIdentityOwner;
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
      throw new GitHubPublicationAuthorityLostError(
        "GitHub publication execution custody changed.",
      );
    }
    currentWorktree();
  };
  const custodyCommands = createGitHubPublicationCommandRunner(assertCustody);
  const { assertCurrent: assertAuthority, refreshIdentity } =
    createGitHubPublicationExecutionIdentity({
      row: initial,
      identity: params.identity,
      validateAuthority: params.validateAuthority,
      assertWorkspace: () => {
        currentWorktree();
      },
    });
  let bound: Awaited<ReturnType<typeof prepareBoundGitHubPublication>> | undefined;
  const assertCurrent = () => {
    assertAuthority();
    bound?.assertCurrent();
  };
  const { step, run, require: command } = createGitHubPublicationCommandRunner(assertCurrent);
  const reconcileObservedPublication = async () => {
    const result = await reconcileGitHubPublication({
      initial: row,
      identity: params.identity,
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
        throw new GitHubPublicationWorkspaceChangedError(
          "GitHub publication workspace changed after its accepted snapshot.",
        );
      }
    }
    let identity = await refreshIdentity();
    if (pullRequest) {
      if (!params.requester || row.identity_source === "personal") {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      try {
        bound = await prepareBoundGitHubPublication({
          pullRequest,
          row,
          cwd: worktree.path,
          requester: params.requester(),
          refreshIdentity,
          assertCurrent: assertAuthority,
        });
      } catch (error) {
        // A journaled commit may already be on the PR beneath a later author push. Only a
        // confirmed observation of that commit settles the request; otherwise the refusal stands.
        // Accepted edge case: GitHub reads report an absent commit and an unavailable one alike,
        // so a transient read failure here also refuses. Waiting instead would leave a journaled
        // commit that never reached GitHub pending forever; the refusal keeps local work, and a
        // refresh of the PR integrates the moved head.
        if (
          error instanceof GitHubPublicationBranchChangedError &&
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
    const { pushRepository, repository, branch, baseBranch, pushOwner, githubHost } =
      await prepareGitHubPublicationTarget({
        worktree,
        identity,
        pullRequest,
        assertCurrent,
      });
    if (
      params.target &&
      (params.target.pushRepository !== pushRepository ||
        params.target.repository !== repository ||
        params.target.baseBranch !== baseBranch)
    ) {
      throw new GitHubPublicationWorkspaceChangedError(
        "GitHub publication accepted repository target changed.",
      );
    }
    const remoteBaseSha = await readGitHubPublicationBaseSha(
      run,
      repository,
      baseBranch,
      githubHost,
      identity.env,
    );
    await step(() => assertSafeGitPublicationWorkspace(worktree.path, runCommand));
    identity = await refreshIdentity();
    const baseTransportEnv = {
      ...identity.env,
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    };
    await requireGitHubPublicationCommit(
      run,
      repository,
      remoteBaseSha,
      githubHost,
      worktree.path,
      baseTransportEnv,
      "GitHub publication workspace base could not be materialized.",
    );
    // Reflogs can expire or restart when a branch is recreated; commits own its history.
    const lineage = await run(["git", "merge-base", sourceHeadCommit, remoteBaseSha], {
      cwd: worktree.path,
    });
    if (lineage.code === 1) {
      throw new GitHubPublicationKnownFailure("GitHub publication histories are unrelated.", {
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
    // A bound PR can legitimately append a full revert of its original contribution.
    if (!pullRequest && baseTree === workspaceTree) {
      throw new GitHubPublicationKnownFailure("GitHub publication has no changes to publish.", {
        code: "no_changes",
        nextAction: "Make or restore a repository change, then retry.",
      });
    }
    const marker = `${PUBLICATION_MARKER}: ${row.request_id}`;
    const pullRequestMarker = `<!-- openclaw-publication:${row.request_id} -->`;
    const head = await command(
      ["git", "show", "-s", "--no-show-signature", "--format=%H%n%T%n%P%n%B", "HEAD"],
      {
        cwd: worktree.path,
      },
    );
    const [initialHead, currentTree, parents, ...message] = head.split("\n");
    let headCommit = initialHead!;
    const markerPresent = message.join("\n").trim().split(/\r?\n/u).includes(marker);
    const requestHeadCommit = markerPresent ? row.head_commit : undefined;
    const findPullRequest = () =>
      findGitHubPublicationPullRequest({
        repository,
        pullRequest,
        pushOwner,
        branch,
        baseBranch,
        host: githubHost,
        ...requestHeadFields(headCommit, requestHeadCommit, sourceHeadCommit),
        marker: pullRequestMarker,
        refreshIdentity,
        recordObserved: async (url) => {
          await params.recordEffect?.("pull_request", { url });
          pullRequestPending = false;
        },
        assertCurrent,
      });
    if (markerPresent) {
      if (parents!.split(" ", 1)[0] !== sourceHeadCommit || currentTree !== workspaceTree) {
        throw new GitHubPublicationWorkspaceChangedError(
          "GitHub publication workspace changed after its accepted snapshot.",
        );
      }
    } else if (headCommit !== sourceHeadCommit) {
      throw new GitHubPublicationWorkspaceChangedError(
        "GitHub publication workspace changed after its accepted snapshot.",
      );
    }
    const httpsRemote = githubRepositoryUrl(pushRepository, githubHost);
    identity = await refreshIdentity();
    let transportEnv = {
      ...identity.env,
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    };
    const observeRemoteHead = async () => {
      const result = await run(githubPublicationRemoteHeadArgs(httpsRemote, branch), {
        cwd: worktree.path,
        env: transportEnv,
      });
      if (result.code !== 0) {
        throw new Error("GitHub publication remote branch could not be verified.");
      }
      const observed = result.stdout.toString("utf8").trim();
      if (!observed) {
        return "";
      }
      const fields = observed.split(/\s+/u);
      if (
        fields.length !== 2 ||
        fields[1] !== `refs/heads/${branch}` ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(fields[0]!)
      ) {
        throw new Error("GitHub publication remote branch could not be verified.");
      }
      return fields[0]!;
    };
    // Observe ancestry before creating bookkeeping commits or installing the accepted index.
    // Fetch objects only: do not move local refs, FETCH_HEAD, or the working tree.
    const expectedRemoteHead = await step(observeRemoteHead);
    let remoteHead = expectedRemoteHead;
    if (remoteHead && remoteHead !== headCommit) {
      await requireGitHubPublicationCommit(
        run,
        pushRepository,
        remoteHead,
        githubHost,
        worktree.path,
        transportEnv,
        "GitHub publication remote branch could not be verified.",
      );
      const ancestry = await run(["git", "merge-base", "--is-ancestor", remoteHead, headCommit], {
        cwd: worktree.path,
      });
      if (ancestry.code === 1) {
        throw new GitHubPublicationBranchChangedError({
          originalPullRequest: Boolean(pullRequest),
        });
      }
      if (ancestry.code !== 0) {
        throw new Error("GitHub publication remote branch could not be verified.");
      }
    }
    const existingPullRequest = await step(findPullRequest);
    const assertWorkflowAuthority = await prepareGitHubPublicationWorkflowGuard(
      params.assertWorkflowChangesAllowed,
      () =>
        hasGitHubPublicationWorkflowChanges({
          cwd: worktree.path,
          comparisonCommit: expectedRemoteHead || lineage.stdout.toString("utf8").trim(),
          ancestryCommit: expectedRemoteHead || sourceHeadCommit,
          targetCommit: remoteBaseSha,
          workspaceTree,
          run,
        }),
    );
    const assertPublicationAction = () => {
      assertWorkflowAuthority();
      assertCurrent();
    };
    assertPublicationAction();
    row = await params.updatePublishingFacts({
      row,
      repository,
      branch,
      baseBranch,
      sourceHeadCommit,
      workspaceTree,
      headCommit,
    });
    const content = await prepareGitHubPublicationContent({
      row,
      requesterProfileId: params.requesterProfileId?.(),
      storePath: loaded.storePath,
      accountId: identity.account.accountId,
      host: githubHost,
      assertCurrent: assertPublicationAction,
      readCurrentEntry: () => currentWorktree().loaded.entry,
      description:
        row.body?.trim() ||
        "Published by the Gateway after authoritative workspace reconciliation.",
    });
    const { assertAction } = content;
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
    assertAction();
    if (
      markerPresent &&
      remoteHead !== headCommit &&
      !hasGitHubPublicationMessageFooter(currentMessage, content.trailers, marker)
    ) {
      throw new GitHubPublicationCreditChangedError();
    }
    const messageLines = currentMessage.split(/\r?\n/u);
    if (
      existingPullRequest &&
      remoteHead === headCommit &&
      currentTree === workspaceTree &&
      sourceIndexTree === workspaceTree &&
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
        return await completePublished(existingPullRequest, headCommit);
      }
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
        ...identity.env,
        GIT_AUTHOR_NAME: identity.account.login,
        GIT_COMMITTER_NAME: identity.account.login,
        GIT_AUTHOR_EMAIL: `${identity.account.accountId}+${identity.account.login}@users.noreply.github.com`,
        GIT_COMMITTER_EMAIL: `${identity.account.accountId}+${identity.account.login}@users.noreply.github.com`,
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
          { cwd: worktree.path, beforeRun: assertCurrent },
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
      env: identity.env,
      assertCurrent,
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
    transportEnv = {
      ...identity.env,
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    };
    if (await bound?.refresh()) {
      return await reconcileObservedPublication();
    }
    const pushArgs = githubPublicationPushArgs(httpsRemote, headCommit, branch, expectedRemoteHead);
    remoteHead = await step(observeRemoteHead);
    if (remoteHead !== headCommit) {
      if (remoteHead !== expectedRemoteHead) {
        throw new GitHubPublicationBranchChangedError({
          originalPullRequest: Boolean(pullRequest),
        });
      }
      assertAction();
      await params.recordEffect?.("push");
      effectDispatched = true;
      const pushed = await runCommand(pushArgs, {
        cwd: worktree.path,
        env: transportEnv,
        beforeRun: assertAction,
      });
      await params.recordEffect?.("push", pushed.code === 0 ? { headCommit } : {});
      assertAuthority();
      identity = await refreshIdentity();
      transportEnv = {
        ...identity.env,
        GIT_CONFIG_GLOBAL: gitNullConfigPath(),
        GIT_CONFIG_SYSTEM: gitNullConfigPath(),
      };
      remoteHead = await step(observeRemoteHead);
      if (remoteHead !== headCommit) {
        const login = identity.account.login;
        throw gitHubPublicationPushFailure(pushed, remoteHead === expectedRemoteHead, {
          login,
          pushRepository,
        });
      }
      await params.recordEffect?.("push", { headCommit });
    }

    if (pullRequest) {
      const url = await reconcileGitHubPublicationPullRequest({
        requestId: row.request_id,
        pullRequest,
        pushRepository,
        repository,
        pushOwner,
        branch,
        baseBranch,
        host: githubHost,
        headCommit,
        workspaceTree,
        parentCommit: sourceHeadCommit,
        marker: pullRequestMarker,
        knownPullRequestUrls: [pullRequest.url],
        refreshIdentity,
        assertCurrent: assertCustody,
        pushOnly: "observed",
      });
      if (!url) {
        throw new GitHubPublicationRecoveryPendingError(
          "The original PR update is unconfirmed; retry recovery before publishing again.",
        );
      }
      return await completePublished(url, headCommit);
    }
    let pullRequestUrl = await findPullRequest();
    if (!pullRequestUrl) {
      identity = await refreshIdentity();
      assertAction();
      await params.recordEffect?.("pull_request");
      pullRequestPending = true;
      effectDispatched = true;
      const created = await runCommand(
        githubPublicationApiArgs(`repos/${repository}/pulls`, "POST", githubHost),
        {
          env: identity.env,
          beforeRun: assertAction,
          input: () =>
            JSON.stringify({
              title: content.title,
              body: content.pullRequestBody(),
              head: `${pushOwner}:${branch}`,
              base: baseBranch,
              // Requests accepted before the choice was introduced created drafts.
              draft: row.draft !== 0,
            }),
        },
      );
      if (created.code === 0) {
        let value: unknown;
        try {
          value = JSON.parse(created.stdout.toString("utf8"));
        } catch (error) {
          throw new Error("GitHub pull request creation returned invalid JSON", { cause: error });
        }
        if (!isRecord(value)) {
          throw new Error("GitHub pull request creation returned an invalid response");
        }
        pullRequestUrl = readNonBlankString(value.html_url);
      }
      await params.recordEffect?.("pull_request", pullRequestUrl ? { url: pullRequestUrl } : {});
      if (!pullRequestUrl) {
        assertAuthority();
        pullRequestUrl = await findPullRequest();
      }
    }
    if (!pullRequestUrl) {
      throw new Error("GitHub pull request creation was rejected.");
    }
    if (pullRequestPending) {
      await params.recordEffect?.("pull_request", { url: pullRequestUrl });
    }
    return await completePublished(pullRequestUrl, headCommit);
  } catch (error) {
    if (
      isAbortError(error) ||
      error instanceof GitHubPublicationRequesterUnavailableError ||
      error instanceof GatewayOperatorAccessUnavailableError ||
      error instanceof GitHubPublicationRecoveryPendingError
    ) {
      throw error;
    }
    if (error instanceof GitHubPublicationAuthorityLostError && params.defer) {
      return projectGitHubPublicationResult(await params.defer(initial));
    }
    if (
      params.interrupt &&
      (effectDispatched || initial.last_effect) &&
      !(error instanceof GitHubPublicationKnownFailure)
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
      !(error instanceof GitHubPublicationKnownFailure)
    ) {
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication is unconfirmed; retry recovery before requesting another publication. Recorded effects are retained.",
        { cause: error },
      );
    }
    const failure = resolveGitHubPublicationFailure(error);
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

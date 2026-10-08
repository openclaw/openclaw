import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { githubRepositoryUrl } from "../agents/github-host.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import { readLocalGitHubPublicationWorktreeOwner } from "./github-publication-availability.js";
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
  findGitHubPublicationPullRequest,
  reconcileGitHubPublicationPullRequest,
} from "./github-publication-pull-requests.js";
import {
  readKnownGitHubPublicationPullRequestUrls,
  recoverGitHubPublicationWorkspace,
} from "./github-publication-recovery.js";
import { projectGitHubPublicationResult } from "./github-publication-store.js";
import { prepareGitHubPublicationTarget } from "./github-publication-target.js";
import { prepareGitHubPublicationWorkflowGuard } from "./github-publication-workflows.js";
import { GatewayOperatorAccessUnavailableError } from "./operator-access-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";

const PUBLICATION_MARKER = "OpenClaw-Publication";

type PublicationRow = GitHubPublicationExecutionRow;

/** Lost requester authority permits receipt reconciliation, never a publication retry. */
export async function reconcileGitHubPublication<Row extends PublicationRow>(params: {
  initial: Row;
  identity?: GitHubPublicationIdentityOwner;
  validateCustody: () => boolean;
  pushOnly?: "observed" | "dispatched";
  complete: (row: Row, result: SessionGitHubPublicationResult) => Row;
}): Promise<SessionGitHubPublicationResult | undefined> {
  const row = params.initial;
  if (row.status === "published" || row.status === "failed") {
    return projectGitHubPublicationResult(row);
  }
  // Shared execution records these facts before dispatching any branch or PR write.
  if (
    !row.repository ||
    !row.base_branch ||
    !row.head_commit ||
    !row.source_head_commit ||
    !row.workspace_tree
  ) {
    return undefined;
  }
  let worktreeOwner: Awaited<ReturnType<typeof readLocalGitHubPublicationWorktreeOwner>>;
  const { assertCurrent, refreshIdentity } = createGitHubPublicationExecutionIdentity({
    row,
    identity: params.identity,
    validateAuthority: params.validateCustody,
    assertWorkspace: () => {
      worktreeOwner.assertCurrent();
    },
  });
  let url: string | undefined;
  try {
    worktreeOwner = await readLocalGitHubPublicationWorktreeOwner(row);
    const { worktree } = worktreeOwner;
    assertCurrent();
    const target = await prepareGitHubPublicationTarget({
      worktree,
      identity: await refreshIdentity(),
      assertCurrent,
    });
    if (
      target.repository !== row.repository ||
      target.branch !== row.branch ||
      target.baseBranch !== row.base_branch
    ) {
      throw new Error("GitHub publication's original target is unavailable.");
    }
    const knownPullRequestUrls = await readKnownGitHubPublicationPullRequestUrls(row);
    assertCurrent();
    url = await reconcileGitHubPublicationPullRequest({
      requestId: row.request_id,
      pushRepository: target.pushRepository,
      repository: row.repository,
      pushOwner: target.pushOwner,
      branch: row.branch,
      baseBranch: row.base_branch,
      headCommit: row.head_commit,
      workspaceTree: row.workspace_tree,
      parentCommit: row.source_head_commit,
      marker: `<!-- openclaw-publication:${row.request_id} -->`,
      knownPullRequestUrls,
      refreshIdentity,
      assertCurrent,
      pushOnly: params.pushOnly,
    });
  } catch (error) {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication is unconfirmed; restore read access to the original target and retry recovery. Recorded effects are retained.",
      { cause: error },
    );
  }
  if (!url) {
    return undefined;
  }
  return projectGitHubPublicationResult(
    params.complete(row, {
      requestId: row.request_id,
      status: "published",
      url,
      repository: row.repository,
      branch: row.branch,
      headCommit: row.head_commit,
    }),
  );
}

export async function executeGitHubPublication<Row extends PublicationRow>(params: {
  initial: Row;
  identity?: GitHubPublicationIdentityOwner;
  target?: { pushRepository: string; repository: string; baseBranch: string };
  recordEffect?: (
    effect: "push" | "pull_request",
    observed?: { headCommit?: string; url?: string },
  ) => void;
  validateAuthority: () => boolean;
  prepareAuthority?: () => Promise<void>;
  validateCustody: () => boolean;
  assertWorkflowChangesAllowed: () => void;
  bindWorkspaceSnapshot: (input: {
    row: Row;
    sourceHeadCommit: string;
    sourceIndexTree: string;
    workspaceTree: string;
  }) => Row;
  updatePublishingFacts: (input: {
    row: Row;
    repository: string;
    branch: string;
    baseBranch: string;
    sourceHeadCommit: string;
    workspaceTree: string;
    headCommit: string;
  }) => Row;
  complete: (row: Row, result: SessionGitHubPublicationResult) => Row;
  defer?: (row: Row) => Row;
  interrupt?: () => Row;
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
    | Awaited<ReturnType<typeof readLocalGitHubPublicationWorktreeOwner>>
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
  const { step, run, require: command } = createGitHubPublicationCommandRunner(assertAuthority);
  try {
    worktreeOwner = await readLocalGitHubPublicationWorktreeOwner(initial);
    const { loaded, worktree } = worktreeOwner;
    await custodyCommands.step(() => assertSafeGitPublicationWorkspace(worktree.path, runCommand));
    await recoverGitHubPublicationWorkspace(
      initial,
      worktree,
      custodyCommands.require,
      assertCustody,
    );
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
      row = params.bindWorkspaceSnapshot({ row, ...snapshot });
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
    let headCommit = await command(["git", "rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: worktree.path,
    });
    let identity = await refreshIdentity();
    const { pushRepository, repository, branch, baseBranch, pushOwner, githubHost } =
      await prepareGitHubPublicationTarget({ worktree, identity, assertCurrent: assertAuthority });
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
    if (baseTree === workspaceTree) {
      throw new GitHubPublicationKnownFailure("GitHub publication has no changes to publish.", {
        code: "no_changes",
        nextAction: "Make or restore a repository change, then retry.",
      });
    }
    const marker = `${PUBLICATION_MARKER}: ${row.request_id}`;
    const pullRequestMarker = `<!-- openclaw-publication:${row.request_id} -->`;
    const findPullRequest = () =>
      findGitHubPublicationPullRequest({
        repository,
        pushOwner,
        branch,
        baseBranch,
        host: githubHost,
        headCommit,
        marker: pullRequestMarker,
        refreshIdentity,
        recordObserved: (url) => {
          params.recordEffect?.("pull_request", { url });
          pullRequestPending = false;
        },
        assertCurrent: assertAuthority,
      });
    const currentMessage = await command(["git", "show", "-s", "--format=%B", "HEAD"], {
      cwd: worktree.path,
    });
    const markerPresent = currentMessage.split(/\r?\n/u).includes(marker);
    const currentTree = await command(["git", "rev-parse", "HEAD^{tree}"], { cwd: worktree.path });
    if (markerPresent) {
      const markerParent = await command(["git", "rev-parse", "HEAD^"], { cwd: worktree.path });
      if (markerParent !== sourceHeadCommit || currentTree !== workspaceTree) {
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
        throw new GitHubPublicationBranchChangedError();
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
      assertAuthority();
    };
    assertPublicationAction();
    row = params.updatePublishingFacts({
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
      storePath: loaded.storePath,
      accountId: identity.account.accountId,
      assertCurrent: assertPublicationAction,
      description: (
        row.body?.trim() || "Published by the Gateway after authoritative workspace reconciliation."
      )
        .replace(/(?:\s*---\s*\n\[View the OpenClaw team session\]\([^\r\n)]*\)\s*)+$/u, "")
        .replace(
          /(?:^|\n\n)## Worked on by\n\n(?:- @[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\n)*- @[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?=\n\n|$)/gu,
          "",
        )
        .trimEnd(),
    });
    const { assertAction } = content;
    const completePublished = (url: string, publishedHead: string) =>
      projectGitHubPublicationResult(
        params.complete(row, {
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
        return completePublished(existingPullRequest, headCommit);
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
        branch,
        async (argv) => (await run(argv, { cwd: worktree.path })).code ?? -1,
      );
      const previousHead = headCommit;
      updateBranchRef = async () => {
        const result = await runCommand(
          githubPublicationUpdateRefArgs(branch, commit, previousHead),
          { cwd: worktree.path, beforeRun: assertAuthority },
        );
        assertGitHubPublicationRefCasCompleted(result);
      };
      headCommit = commit;
    }
    await updateGitHubPublicationBranchAndIndex({
      cwd: worktree.path,
      requestId: row.request_id,
      branch,
      previousHead: previousBranchHead,
      sourceIndexTree,
      workspaceTree,
      headCommit,
      env: identity.env,
      assertCurrent: assertAuthority,
      assertCustody,
      run: custodyCommands.require,
      ...(updateBranchRef ? { updateRef: updateBranchRef } : {}),
    });
    row = params.updatePublishingFacts({
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
    const pushArgs = githubPublicationPushArgs(httpsRemote, headCommit, branch, expectedRemoteHead);
    remoteHead = await step(observeRemoteHead);
    if (remoteHead !== headCommit) {
      if (remoteHead !== expectedRemoteHead) {
        throw new GitHubPublicationBranchChangedError();
      }
      assertAction();
      params.recordEffect?.("push");
      effectDispatched = true;
      const pushed = await runCommand(pushArgs, {
        cwd: worktree.path,
        env: transportEnv,
        beforeRun: assertAction,
      });
      params.recordEffect?.("push", pushed.code === 0 ? { headCommit } : {});
      assertAuthority();
      identity = await refreshIdentity();
      transportEnv = {
        ...identity.env,
        GIT_CONFIG_GLOBAL: gitNullConfigPath(),
        GIT_CONFIG_SYSTEM: gitNullConfigPath(),
      };
      remoteHead = await step(observeRemoteHead);
      if (remoteHead !== headCommit) {
        throw new Error(
          pushed.code === 0 ? "GitHub push verification failed." : "GitHub push was rejected.",
        );
      }
      params.recordEffect?.("push", { headCommit });
    }

    let pullRequestUrl = await findPullRequest();
    if (!pullRequestUrl) {
      const body = content.pullRequestBody();
      identity = await refreshIdentity();
      assertAction();
      params.recordEffect?.("pull_request");
      pullRequestPending = true;
      effectDispatched = true;
      const created = await runCommand(
        githubPublicationApiArgs(`repos/${repository}/pulls`, "POST", githubHost),
        {
          env: identity.env,
          beforeRun: assertAction,
          input: JSON.stringify({
            title: content.title,
            body,
            head: `${pushOwner}:${branch}`,
            base: baseBranch,
            draft: true,
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
      params.recordEffect?.("pull_request", pullRequestUrl ? { url: pullRequestUrl } : {});
      if (!pullRequestUrl) {
        assertAuthority();
        pullRequestUrl = await findPullRequest();
      }
    }
    if (!pullRequestUrl) {
      throw new Error("GitHub pull request creation was rejected.");
    }
    if (pullRequestPending) {
      params.recordEffect?.("pull_request", { url: pullRequestUrl });
    }
    return completePublished(pullRequestUrl, headCommit);
  } catch (error) {
    if (
      error instanceof GitHubPublicationRequesterUnavailableError ||
      error instanceof GatewayOperatorAccessUnavailableError
    ) {
      throw error;
    }
    if (error instanceof GitHubPublicationRecoveryPendingError) {
      throw error;
    }
    if (error instanceof GitHubPublicationAuthorityLostError && params.defer) {
      return projectGitHubPublicationResult(params.defer(initial));
    }
    if (
      params.interrupt &&
      (effectDispatched || initial.last_effect) &&
      !(error instanceof GitHubPublicationKnownFailure)
    ) {
      // Unavailable observations cannot settle dispatched effects; only an owner's
      // definitive outcome ends recovery, retaining any already-recorded effects.
      assertAuthority();
      return projectGitHubPublicationResult(params.interrupt());
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
      params.complete(initial, {
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
  }
}

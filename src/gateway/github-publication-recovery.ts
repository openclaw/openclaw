import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type {
  GitHubPublicationExecutionRow,
  GitHubPublicationRow,
} from "../state/github-publication-read.types.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { readLocalGitHubPublicationWorktreeOwner } from "./github-publication-availability.js";
import {
  createGitHubPublicationExecutionIdentity,
  GitHubPublicationAuthorityLostError,
  type GitHubPublicationIdentityOwner,
} from "./github-publication-execution-identity.js";
import {
  GitHubPublicationRecoveryPendingError,
  recoverGitHubPublicationBranchAndIndex,
} from "./github-publication-git-index.js";
import {
  assertSafeGitPublicationWorkspace,
  createGitHubPublicationCommandRunner,
  runPublicationCommand,
} from "./github-publication-git-transport.js";
import { reconcileGitHubPublicationPullRequest } from "./github-publication-pull-requests.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import { prepareGitHubPublicationTarget } from "./github-publication-target.js";

export type GitHubPublicationRecoveryBackoff = ReturnType<
  typeof createGitHubPublicationRecoveryBackoff
>;

/** Backoff is process-local; the receipt age also bounds recovery across restarts. */
export function createGitHubPublicationRecoveryBackoff() {
  const failures = new Map<
    string,
    { attempts: number; delayMs: number; retryAtMs: number; diagnostic: string }
  >();
  return {
    clear: () => failures.clear(),
    retain(requestIds: string[]) {
      const pending = new Set(requestIds);
      for (const requestId of failures.keys()) {
        if (!pending.has(requestId)) {
          failures.delete(requestId);
        }
      }
    },
    async run(
      row: { request_id: string; created_at_ms: number },
      operation: () => Promise<SessionGitHubPublicationResult | void>,
      settle: (result: SessionGitHubPublicationResult) => Promise<SessionGitHubPublicationResult>,
    ) {
      const requestId = row.request_id;
      const previous = failures.get(requestId);
      if (previous && performance.now() < previous.retryAtMs) {
        return;
      }
      const defer = (error: unknown) => {
        const delayMs = Math.min((previous?.delayMs ?? 30_000) * 2, 30 * 60_000);
        const deferred = {
          attempts: (previous?.attempts ?? 0) + 1,
          delayMs,
          retryAtMs: performance.now() + delayMs,
          diagnostic: redactToolPayloadText(formatErrorMessage(error)).slice(0, 2_048),
        };
        failures.set(requestId, deferred);
        return deferred;
      };
      let result: SessionGitHubPublicationResult | void = undefined;
      let failure: unknown;
      try {
        if ((previous?.attempts ?? 0) >= 3) {
          throw new Error(previous?.diagnostic);
        }
        result = await operation();
        if (!result || (result.status !== "requested" && result.status !== "publishing")) {
          failures.delete(requestId);
          return result;
        }
        failure = result.message;
      } catch (error) {
        failure = error;
      }
      // Three failed attempts suffice for transient outages. An old receipt gets one
      // final attempt after restart, so frequent restarts cannot extend recovery forever.
      const deferred = defer(failure);
      if ((previous?.attempts ?? 0) >= 2 || Date.now() - row.created_at_ms >= 60 * 60_000) {
        // A failed settlement retries only the receipt write, never GitHub effects.
        deferred.attempts = 3;
        const settled = await settle({
          requestId,
          status: "failed",
          code: "unavailable",
          message: "GitHub publication recovery stopped with an unconfirmed outcome.",
          nextAction:
            "Automatic recovery stopped because the original publication remains unconfirmed. Recorded GitHub effects and saved work are retained. Inspect the original target and any existing branch or pull request before requesting a new publication; it may already have succeeded.",
        });
        failures.delete(requestId);
        return settled;
      }
      if (!result) {
        throw failure;
      }
      return result;
    },
    describe(result: SessionGitHubPublicationResult): SessionGitHubPublicationResult {
      const failure = failures.get(result.requestId);
      return failure && (result.status === "requested" || result.status === "publishing")
        ? {
            ...result,
            message: `Automatic recovery deferred; next attempt in ${Math.max(0, Math.ceil((failure.retryAtMs - performance.now()) / 1_000))} seconds. Recorded effects are retained; do not request another publication. ${failure.diagnostic}`,
          }
        : result;
    },
  };
}

/** Workspace cleanup precedes every recovered settlement, even without publish authority. */
export async function prepareGitHubPublicationWorkspaceRecovery<
  Row extends GitHubPublicationExecutionRow,
>(params: {
  initial: Row;
  validateCustody: () => boolean;
  recoveryResult?: SessionGitHubPublicationResult;
  complete: (row: Row, result: SessionGitHubPublicationResult) => Row | Promise<Row>;
}) {
  const owner = await readLocalGitHubPublicationWorktreeOwner(params.initial);
  const assertCustody = () => {
    if (!params.validateCustody()) {
      throw new GitHubPublicationAuthorityLostError(
        "GitHub publication execution custody changed.",
      );
    }
    owner.assertCurrent();
  };
  const commands = createGitHubPublicationCommandRunner(assertCustody);
  try {
    await commands.step(() =>
      assertSafeGitPublicationWorkspace(owner.worktree.path, runPublicationCommand),
    );
    await recoverGitHubPublicationWorkspace(
      params.initial,
      owner.worktree,
      commands.require,
      assertCustody,
    );
    let recoveryResult: SessionGitHubPublicationResult | undefined;
    if (params.recoveryResult) {
      assertCustody();
      recoveryResult = projectGitHubPublicationResult(
        await params.complete(params.initial, params.recoveryResult),
      );
    }
    return { ...owner, recoveryResult };
  } catch (error) {
    owner.release();
    throw error;
  }
}

async function recoverGitHubPublicationWorkspace(
  row: GitHubPublicationExecutionRow,
  worktree: ManagedWorktreeRecord,
  run: Parameters<typeof recoverGitHubPublicationBranchAndIndex>[0]["run"],
  assertCustody: () => void,
): Promise<void> {
  if (
    worktree.id !== row.worktree_id ||
    worktree.removedAt !== undefined ||
    worktree.repoFingerprint !== row.repository_fingerprint ||
    !row.source_head_commit ||
    !row.workspace_tree
  ) {
    return;
  }
  await recoverGitHubPublicationBranchAndIndex({
    cwd: worktree.path,
    requestId: row.request_id,
    branch: worktree.branch,
    sourceHeadCommit: row.source_head_commit,
    workspaceTree: row.workspace_tree,
    assertCustody,
    run,
  });
}

async function readKnownGitHubPublicationPullRequestUrls(
  row: GitHubPublicationExecutionRow,
): Promise<string[]> {
  const result = await executeExistingOpenClawStateRead(
    {},
    {
      type: "githubPublication.knownPullRequestUrls",
      input: {
        worktree_id: row.worktree_id,
        repository_fingerprint: row.repository_fingerprint,
        repository: row.repository,
        branch: row.branch,
        base_branch: row.base_branch,
        identity_account_id: row.identity_account_id,
        pull_request_url: row.pull_request_url,
      },
    },
    { current: true },
  );
  if (!result) {
    throw new Error("GitHub publication receipt history is unavailable.");
  }
  return result.urls;
}

export async function readGitHubPublicationRequestInWorker(
  requestId: string,
): Promise<GitHubPublicationRow | undefined> {
  const result = await executeExistingOpenClawStateRead(
    {},
    { type: "githubPublication.request", requestId },
    { current: true },
  );
  if (!result) {
    throw new Error("GitHub publication receipt is unavailable.");
  }
  return result.row;
}

/** Lost requester authority permits receipt reconciliation, never a publication retry. */
export async function reconcileGitHubPublication<
  Row extends GitHubPublicationExecutionRow,
>(params: {
  initial: Row;
  identity?: GitHubPublicationIdentityOwner;
  validateCustody: () => boolean;
  pushOnly?: "observed" | "dispatched";
  complete: (row: Row, result: SessionGitHubPublicationResult) => Row | Promise<Row>;
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
  let releaseWorktree: (() => void) | undefined;
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
    releaseWorktree = worktreeOwner.release;
    const { worktree } = worktreeOwner;
    assertCurrent();
    const target = await prepareGitHubPublicationTarget({
      worktree,
      pullRequest: worktreeOwner.loaded.entry.worktree?.githubPullRequest,
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
      pullRequest: worktreeOwner.loaded.entry.worktree?.githubPullRequest,
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
  } finally {
    releaseWorktree?.();
  }
  if (!url) {
    return undefined;
  }
  return projectGitHubPublicationResult(
    await params.complete(row, {
      requestId: row.request_id,
      status: "published",
      url,
      repository: row.repository,
      branch: row.branch,
      headCommit: row.head_commit,
    }),
  );
}

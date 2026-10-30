import {
  GatewayErrorDetailCodes,
  type GitHubPublicationSelectionRejectedErrorDetails,
} from "../../packages/gateway-protocol/src/gateway-error-details.js";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";

type PublicationFailure = Pick<
  Extract<SessionGitHubPublicationResult, { status: "failed" }>,
  "code" | "nextAction"
>;

export type GitHubPublicationPreparation = {
  idempotencyKey: string;
  hasRequest: () => boolean;
};
const identityNextAction =
  "Reconnect My GitHub or System GitHub in Settings → Profile → GitHub connections (agent overrides: Agents → Tools), then request publication again.";

/** An owner observed a definitive outcome; an unavailable probe is not this failure. */
export class GitHubPublicationKnownFailure extends Error {
  constructor(
    message: string,
    readonly failure: PublicationFailure,
    readonly rejection?: GitHubPublicationSelectionRejectedErrorDetails,
  ) {
    super(message);
  }
}

export function rejectGitHubPublicationSelection(
  message: string,
  preparation?: GitHubPublicationPreparation,
): never {
  let rejection: GitHubPublicationSelectionRejectedErrorDetails | undefined;
  try {
    // Check at rejection, not before awaited preparation. Another invocation may have admitted.
    if (preparation && !preparation.hasRequest()) {
      rejection = {
        code: GatewayErrorDetailCodes.GITHUB_PUBLICATION_SELECTION_REJECTED,
        idempotencyKey: preparation.idempotencyKey,
      };
    }
  } catch {
    // An unreadable receipt cannot establish that publication was not admitted.
  }
  throw new GitHubPublicationKnownFailure(
    message,
    { code: "identity_changed", nextAction: identityNextAction },
    rejection,
  );
}

export class GitHubPublicationWorkspaceChangedError extends GitHubPublicationKnownFailure {
  constructor(message: string) {
    super(message, {
      code: "workspace_changed",
      nextAction:
        "Inspect the reconciled workspace and any recorded GitHub effects, then request a new publication after reviewing the changes.",
    });
  }
}

export class GitHubPublicationBranchChangedError extends GitHubPublicationKnownFailure {
  constructor(options: { originalPullRequest?: boolean } = {}) {
    super("GitHub publication cannot safely extend the published branch.", {
      code: "push_rejected",
      nextAction: options.originalPullRequest
        ? "Preserve your local work and inspect the original PR's current head. Continue only after its updated source has been explicitly accepted and your intended edits reapplied without rewriting published history. Do not create a replacement PR or redirect publication to another branch."
        : "Preserve your local work and inspect the published head. If this conversation published the PR from its managed workspace, call prepare_pr with its URL to merge the newer head into the saved work, then publish again; otherwise publish from a new session branch and open a replacement PR. Repository-only checkpoints cannot adopt external branch changes; use a new session branch for those. Do not merge old history merely to make a rebased branch pushable. The broker never rewrites published history.",
    });
  }
}

/**
 * Classify a push whose head did not land. Git exiting on its own with a failure while the
 * remote still holds its pre-push head is a definitive rejection. Anything else (exit 0, a
 * killed or signalled push, or a moved remote) stays unconfirmed for recovery to settle.
 */
export function gitHubPublicationPushFailure(
  pushed: { code: number | null; signal: unknown; killed: boolean },
  remoteUnchanged: boolean,
  { login, pushRepository }: { login: string; pushRepository: string },
): Error {
  if (!remoteUnchanged || pushed.code === 0 || pushed.signal !== null || pushed.killed) {
    return new Error(
      pushed.code === 0 ? "GitHub push verification failed." : "GitHub push was rejected.",
    );
  }
  return new GitHubPublicationKnownFailure(`GitHub rejected the push to ${pushRepository}.`, {
    code: "push_rejected",
    nextAction: `GitHub rejected @${login}'s push to ${pushRepository}; nothing was pushed. Give @${login} write access (or point the worktree's origin at a fork it owns) and check the repository's branch rules, then request publication again.`,
  });
}

export class GitHubPublicationSessionChangedError extends GitHubPublicationKnownFailure {
  constructor() {
    super("GitHub publication session lifecycle changed.", {
      code: "session_changed",
      nextAction:
        "Review any recorded GitHub effects, then request publication from the current session.",
    });
  }
}

export class GitHubPublicationRequesterUnavailableError extends GitHubPublicationKnownFailure {
  constructor() {
    super("The original GitHub publication requester is no longer authorized.", {
      code: "identity_changed",
      nextAction:
        "Review any recorded or unconfirmed GitHub effects, then request publication again from an authorized session. Saved work and existing pull requests are retained.",
    });
  }
}

export class GitHubPublicationCreditChangedError extends GitHubPublicationKnownFailure {
  constructor() {
    super("GitHub publication contributor credit changed.", {
      code: "identity_changed",
      nextAction:
        "Review contributor credit and any recorded GitHub effects, reconcile unpushed prepared commits, then request a new publication. Already published commits and pull requests are retained.",
    });
  }
}

export class GitHubPublicationWorkflowChangesError extends GitHubPublicationKnownFailure {
  constructor() {
    super("Publishing GitHub workflow changes requires full operator write permission.", {
      code: "github_rejected",
      nextAction:
        "OpenClaw requires the requester's full operator write authority for these workflow changes; this is not a GitHub token scope failure. Your saved changes are intact. Ask a maintainer with full write access to publish, or remove only unintended workflow edits after reviewing the accepted diff.",
    });
  }
}

export function resolveGitHubPublicationFailure(error: unknown): PublicationFailure {
  if (error instanceof GitHubPublicationKnownFailure) {
    return error.failure;
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("publication workspace base")) {
    return {
      code: "unavailable",
      nextAction:
        "The pull request base or its Git history could not be verified. Check repository read access, connectivity, and local Git objects before retrying publication.",
    };
  }
  if (message.includes("publication remote branch could not be verified")) {
    return {
      code: "unavailable",
      nextAction:
        "Restore repository read access or connectivity, then verify the published branch before retrying. An unavailable observation does not prove the branch is absent or safe to overwrite.",
    };
  }
  if (message.includes("identity")) {
    return {
      code: message.includes("changed") ? "identity_changed" : "identity_unavailable",
      nextAction: identityNextAction,
    };
  }
  if (message.includes("session") || message.includes("worktree owner")) {
    return {
      code: "session_changed",
      nextAction: "Open the current session worktree and request publication again.",
    };
  }
  if (message.includes("transport configuration") || message.includes("replacement metadata")) {
    return {
      code: "workspace_changed",
      nextAction:
        "Remove the unsupported Git transport or replacement configuration from the session worktree, then retry.",
    };
  }
  if (message.includes("workspace") || message.includes("branch changed")) {
    return {
      code: "workspace_changed",
      nextAction:
        "Inspect the reconciled workspace and any recorded GitHub effects, then request a new publication after reviewing the changes.",
    };
  }
  if (message.includes("not a git")) {
    return { code: "not_git", nextAction: "Use a session-owned Git worktree to publish." };
  }
  if (message.includes("GitHub remote")) {
    return { code: "not_github", nextAction: "Use a GitHub repository remote to publish." };
  }
  if (message.includes("push")) {
    return {
      code: "push_rejected",
      nextAction:
        "Check repository write access and branch drift, then retry without force-pushing.",
    };
  }
  if (message.includes("pull request") || message.includes("GitHub")) {
    return {
      code: "github_rejected",
      nextAction: "Check pull-request permission for the effective account, then retry.",
    };
  }
  return { code: "unavailable", nextAction: "Retry after the Gateway and GitHub are available." };
}

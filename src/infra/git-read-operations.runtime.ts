import { readRepositoryBranches } from "../agents/worktrees/branches.runtime.js";
import {
  readCheckoutGitContext,
  readPullRequestBranchFacts,
} from "../gateway/control-ui-session-prs-git.runtime.js";
import {
  collectCheckoutDiff,
  collectCheckoutDiffBaseline,
} from "../sessions/session-diff.runtime.js";
import type { GitReadOperation, GitReadOperationResult } from "./git-read-operations.js";

export async function executeGitReadOperation(
  operation: GitReadOperation,
): Promise<GitReadOperationResult> {
  switch (operation.type) {
    case "checkout.context":
      return await readCheckoutGitContext(operation.input.root);
    case "checkout.diff":
      return await collectCheckoutDiff(operation.input);
    case "checkout.baseline":
      return await collectCheckoutDiffBaseline(operation.input);
    case "repository.branches":
      return await readRepositoryBranches(operation.input.repoRoot, operation.input);
    case "pull-request.branch-facts":
      return await readPullRequestBranchFacts(operation.input);
  }
  throw new Error("Unsupported Git read operation");
}

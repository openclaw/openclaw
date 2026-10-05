import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../packages/gateway-protocol/src/index.js";

/** Public selectors cannot replace the thread's selected-project source or base. */
export function validateRequiredWorkspaceSelectors(
  params: SessionsCreateParams,
  policy: { worktreeBaseRef: string },
): ErrorShape | undefined {
  if (
    params.cwd ||
    params.execNode ||
    params.projectGitUrl ||
    params.repository ||
    params.catalogId ||
    params.incognito ||
    params.worktreeSource === "empty" ||
    params.worktree === false ||
    (params.worktreeBaseRef && params.worktreeBaseRef !== policy.worktreeBaseRef)
  ) {
    return errorShape(
      ErrorCodes.FORBIDDEN,
      "This thread requires its selected workspace and recorded worktree base. Remove custom paths, repository sources, and execution-node overrides.",
    );
  }
  return undefined;
}

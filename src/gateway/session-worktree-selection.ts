import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../packages/gateway-protocol/src/index.js";

export function validateSessionWorktreeSelection(
  params: SessionsCreateParams,
): ErrorShape | undefined {
  if (
    params.worktreeSource === "empty" &&
    (params.worktree !== true ||
      params.cwd ||
      params.projectId ||
      params.projectGitUrl ||
      params.repository ||
      params.catalogId ||
      params.execNode ||
      params.worktreeBaseRef)
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create worktreeSource=empty requires worktree=true and cannot include another workspace source, catalog, execNode, or worktreeBaseRef",
    );
  }
  if (normalizeOptionalString(params.execNode) && params.worktree === true) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create worktree cannot target execNode",
    );
  }
  if (
    (normalizeOptionalString(params.worktreeBaseRef) ||
      normalizeOptionalString(params.worktreeName)) &&
    params.worktree !== true
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create worktreeBaseRef/worktreeName require worktree=true",
    );
  }
  return undefined;
}

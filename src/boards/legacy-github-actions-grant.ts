// Existing Board grants keep their wire format even when the GitHub plugin is disabled.
import { z } from "zod";
import { BoardValidationError } from "./board-errors.js";

export const GITHUB_ACTIONS_BINDING_ID = "github.actions.runs";
export const GITHUB_ACTIONS_GRANT_PREFIX = `${GITHUB_ACTIONS_BINDING_ID}:`;

export const GitHubActionsRepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u)
  .refine((value) => ![".", ".."].includes(value.split("/")[1]!))
  .transform((value) => value.toLowerCase());

export function normalizeGitHubActionsGrant(tool: string): string {
  if (!tool.startsWith(GITHUB_ACTIONS_GRANT_PREFIX)) {
    return tool;
  }
  const parsed = GitHubActionsRepositorySchema.safeParse(
    tool.slice(GITHUB_ACTIONS_GRANT_PREFIX.length),
  );
  if (!parsed.success) {
    throw new BoardValidationError("invalid_operation", "GitHub Actions grant requires owner/repo");
  }
  return `${GITHUB_ACTIONS_GRANT_PREFIX}${parsed.data}`;
}

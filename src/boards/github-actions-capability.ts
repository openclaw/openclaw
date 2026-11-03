import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { z } from "zod";
import { BoardValidationError } from "./board-layout.js";
import {
  GITHUB_ACTIONS_GRANT_PREFIX,
  GitHubActionsRepositorySchema as repositorySchema,
} from "./legacy-github-actions-grant.js";
export {
  GITHUB_ACTIONS_BINDING_ID,
  GITHUB_ACTIONS_GRANT_PREFIX,
  normalizeGitHubActionsGrant,
} from "./legacy-github-actions-grant.js";

export const GITHUB_ACTIONS_AUTHOR_GUIDANCE =
  'With a usable connected agent GitHub identity: await openclaw.data.read("github.actions.runs",{repository:"owner/repo",perPage:20}); grant capabilities.tools:["github.actions.runs:owner/repo"]. Uses the agent GitHub identity and cached server reads; direct fetch(api.github.com) is anonymous and rate limited. Identity is checked before save; reconnect in Settings if unavailable. Optional workflow (ID/filename), branch, status, created (ISO day/comparison/range), excludePullRequests=true (omits PR objects); perPage 1..30. Shares private Actions metadata with the widget/session audience; never preview or My GitHub auth. No netOrigins needed.';

const day = "\\d{4}-\\d{2}-\\d{2}";
const createdSchema = z
  .string()
  .regex(new RegExp(`^(?:[<>]=?)?${day}$|^${day}\\.\\.${day}$`, "u"))
  .refine((value) =>
    (value.match(/\d{4}-\d{2}-\d{2}/gu) ?? []).every((date) => {
      const parsed = new Date(`${date}T00:00:00Z`);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(date);
    }),
  );
const paramsSchema = z.strictObject({
  repository: repositorySchema,
  workflow: z
    .union([
      z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      z
        .string()
        .max(255)
        .regex(/^(?:[1-9]\d*|[A-Za-z0-9_.-]+\.ya?ml)$/u)
        .refine((value) => !/^\d+$/u.test(value) || Number.isSafeInteger(Number(value))),
    ])
    .optional(),
  perPage: z.number().int().min(1).max(30).default(20),
  branch: z
    .string()
    .min(1)
    .max(255)
    // Git ref names forbid C0 and DEL (git-check-ref-format, rule 4).
    .refine((value) => !containsAsciiControlCharacter(value))
    .optional(),
  status: z
    .enum([
      "completed",
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "skipped",
      "stale",
      "success",
      "timed_out",
      "in_progress",
      "queued",
      "requested",
      "waiting",
      "pending",
    ])
    .optional(),
  created: createdSchema.optional(),
  excludePullRequests: z.boolean().default(true),
});

/** The same closed contract owns URL construction and the exact repository grant. */
export function resolveGitHubActionsRequest(params: Record<string, unknown>) {
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) {
    throw new BoardValidationError(
      "invalid_operation",
      "Invalid GitHub Actions parameters: use repository (owner/repo), workflow, perPage (1..30), branch, status, created, or excludePullRequests only",
    );
  }
  const input = parsed.data;
  const repositoryPath = input.repository.split("/").map(encodeURIComponent).join("/");
  const operation =
    input.workflow === undefined
      ? "runs"
      : `workflows/${encodeURIComponent(String(input.workflow))}/runs`;
  const url = new URL(`https://api.github.com/repos/${repositoryPath}/actions/${operation}`);
  url.searchParams.set("per_page", String(input.perPage));
  url.searchParams.set("exclude_pull_requests", String(input.excludePullRequests));
  for (const field of ["branch", "status", "created"] as const) {
    if (input[field] !== undefined) {
      url.searchParams.set(field, input[field]);
    }
  }
  return {
    ...input,
    url: url.href,
    capability: `${GITHUB_ACTIONS_GRANT_PREFIX}${input.repository}`,
  };
}

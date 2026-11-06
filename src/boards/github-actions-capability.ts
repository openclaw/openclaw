import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { z } from "zod";
import {
  BOARD_GITHUB_ACTIONS_QUERY_FIELDS,
  type BoardWidgetDataQuery,
} from "../../packages/gateway-protocol/src/schema/board.js";
import { BoardValidationError } from "./board-layout.js";

export const GITHUB_ACTIONS_BINDING_ID = "github.actions.runs";
export const GITHUB_ACTIONS_GRANT_PREFIX = `${GITHUB_ACTIONS_BINDING_ID}:`;
export const GITHUB_ACTIONS_AUTHOR_GUIDANCE =
  'Saved Actions summaries: use session:report. Live refresh: declare capabilities.queries with name, bindingId:"github.actions.runs", complete params (repository, workflow, branch, status, created, perPage:1..30, excludePullRequests), and selected fields; explicit null means all/no filter. Call openclaw.data.query(name). Approval shares selected private and future results using agent credentials with session readers. Query edits require renewed approval. Repository-only grants/data.read do not authorize session-only readers. Needs usable agent GitHub identity; reconnect in Settings if unavailable. No netOrigins.';

const repositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u)
  .refine((value) => ![".", ".."].includes(value.split("/")[1]!))
  .transform((value) => value.toLowerCase());
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

const queriesSchema = z
  .array(
    z.strictObject({
      name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
      bindingId: z.literal(GITHUB_ACTIONS_BINDING_ID),
      params: paramsSchema.extend({
        workflow: paramsSchema.shape.workflow.unwrap().nullable(),
        branch: paramsSchema.shape.branch.unwrap().nullable(),
        status: paramsSchema.shape.status.unwrap().nullable(),
        created: paramsSchema.shape.created.unwrap().nullable(),
        perPage: paramsSchema.shape.perPage.removeDefault(),
        excludePullRequests: paramsSchema.shape.excludePullRequests.removeDefault(),
      }),
      fields: z.array(z.enum(BOARD_GITHUB_ACTIONS_QUERY_FIELDS)).min(1).max(14),
    }),
  )
  .max(8);

/** Stored definitions use the same selectors as the Actions adapter, with no runtime defaults. */
export function normalizeBoardWidgetDataQueries(value: unknown): BoardWidgetDataQuery[] {
  if (value === undefined) {
    return [];
  }
  const parsed = queriesSchema.safeParse(value);
  if (
    !parsed.success ||
    new Set(parsed.data.map((query) => query.name)).size !== parsed.data.length
  ) {
    throw new BoardValidationError(
      "invalid_operation",
      "Invalid named Actions queries: use unique names, explicit selectors (null for all/no filter), perPage 1..30, excludePullRequests, and selected response fields",
    );
  }
  for (const query of parsed.data) {
    query.fields = [...new Set(query.fields)].toSorted();
  }
  return parsed.data.toSorted((a, b) => (a.name < b.name ? -1 : 1));
}

export function boardWidgetDataQueryParams(query: BoardWidgetDataQuery): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query.params).filter(([, value]) => value !== null));
}

export function normalizeGitHubActionsGrant(tool: string): string {
  if (!tool.startsWith(GITHUB_ACTIONS_GRANT_PREFIX)) {
    return tool;
  }
  const parsed = repositorySchema.safeParse(tool.slice(GITHUB_ACTIONS_GRANT_PREFIX.length));
  if (!parsed.success) {
    throw new BoardValidationError("invalid_operation", "GitHub Actions grant requires owner/repo");
  }
  return `${GITHUB_ACTIONS_GRANT_PREFIX}${parsed.data}`;
}

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

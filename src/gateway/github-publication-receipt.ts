import { createHash } from "node:crypto";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type {
  GitHubPublicationExecutionRow,
  GitHubPublicationRow,
} from "../state/github-publication-read.types.js";

type PublicationFailureCode = Extract<SessionGitHubPublicationResult, { status: "failed" }>["code"];

const PUBLICATION_FAILURE_CODES = new Set<string>([
  "identity_changed",
  "identity_unavailable",
  "session_changed",
  "workspace_changed",
  "not_git",
  "not_github",
  "no_changes",
  "push_rejected",
  "github_rejected",
  "unavailable",
]);

function publicationFailureCode(value: string): PublicationFailureCode {
  // SAFETY: membership in the closed protocol vocabulary narrows this stored string.
  return PUBLICATION_FAILURE_CODES.has(value) ? (value as PublicationFailureCode) : "unavailable";
}

export function checkSharedWorktreeReceipt(row: GitHubPublicationRow): void {
  assertReadableSharedGitHubPublication(row);
  if (
    row.request_digest !==
    digestGitHubPublicationRequest({
      sessionId: row.session_id,
      idempotencyKey: row.idempotency_key,
      title: row.title ?? undefined,
      body: row.body ?? undefined,
    })
  ) {
    throw new Error("GitHub publication receipt is corrupt.");
  }
}

/** A malformed terminal row must not project as a new, pending publication. */
export function assertReadableSharedGitHubPublication(
  row: Parameters<typeof projectGitHubPublicationResult>[0],
): void {
  if (
    !["agent-override", "system-configured", "system-detected"].includes(row.identity_source) ||
    !Number.isSafeInteger(row.identity_account_id) ||
    row.identity_account_id <= 0 ||
    !row.identity_login ||
    !["requested", "publishing", "published", "failed"].includes(row.status) ||
    (row.status === "published" &&
      (!row.pull_request_url || !row.repository || !row.branch || !row.head_commit)) ||
    (row.status === "failed" &&
      (!row.error_code || !PUBLICATION_FAILURE_CODES.has(row.error_code) || !row.next_action))
  ) {
    throw new Error("Shared GitHub publication receipt is corrupt.");
  }
}

export function matchesGitHubPublicationIdentityRow(
  row: Pick<
    GitHubPublicationExecutionRow,
    | "identity_source"
    | "identity_profile_id"
    | "identity_account_id"
    | "identity_login"
    | "agent_id"
  >,
  identity: Pick<PreparedGitHubPublicationIdentity, "source" | "profileId" | "account">,
): boolean {
  return (
    row.identity_source === identity.source &&
    row.identity_profile_id === (identity.profileId ?? null) &&
    row.identity_account_id === identity.account.accountId &&
    row.identity_login.toLowerCase() === identity.account.login.toLowerCase()
  );
}

export function digestGitHubPublicationRequest(params: {
  sessionId: string;
  idempotencyKey: string;
  title?: string;
  body?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: params.sessionId,
        idempotencyKey: params.idempotencyKey,
        title: params.title ?? null,
        body: params.body ?? null,
      }),
    )
    .digest("hex");
}

export function projectGitHubPublicationResult(
  row: Pick<
    GitHubPublicationExecutionRow,
    | "request_id"
    | "identity_source"
    | "identity_account_id"
    | "identity_login"
    | "status"
    | "head_commit"
    | "pull_request_url"
    | "repository"
    | "branch"
    | "error_code"
    | "next_action"
    | "last_effect"
    | "effect_state"
  >,
): SessionGitHubPublicationResult {
  const effect: Pick<SessionGitHubPublicationResult, "effect"> =
    (row.last_effect === "push" || row.last_effect === "pull_request") &&
    (row.effect_state === "dispatched" || row.effect_state === "observed")
      ? {
          effect: {
            kind: row.last_effect,
            status: row.effect_state,
            ...(row.head_commit ? { headCommit: row.head_commit } : {}),
            ...(row.pull_request_url ? { url: row.pull_request_url } : {}),
          },
        }
      : {};
  const common = {
    requestId: row.request_id,
    publisher: {
      source:
        row.identity_source === "personal" ||
        row.identity_source === "agent-override" ||
        row.identity_source === "system-configured"
          ? row.identity_source
          : "system-detected",
      accountId: row.identity_account_id,
      login: row.identity_login,
    },
    ...effect,
  } satisfies Pick<SessionGitHubPublicationResult, "requestId" | "publisher" | "effect">;
  if (row.status === "published" && row.pull_request_url && row.repository && row.branch) {
    return {
      ...common,
      status: "published",
      url: row.pull_request_url,
      repository: row.repository,
      branch: row.branch,
      headCommit: row.head_commit ?? "unknown",
    };
  }
  if (row.status === "failed" && row.error_code && row.next_action) {
    return {
      ...common,
      status: "failed",
      code: publicationFailureCode(row.error_code),
      message: "GitHub publication failed.",
      nextAction: row.next_action,
    };
  }
  if (row.status === "needs_confirmation") {
    return {
      ...common,
      status: "needs_confirmation",
      message:
        "Confirm the original My GitHub account, target, and workspace to continue this interrupted publication. Already-dispatched GitHub effects may have completed; confirmation checks them before retrying.",
    };
  }
  return {
    ...common,
    status: row.status === "publishing" ? "publishing" : "requested",
    message:
      row.status === "publishing"
        ? "The Gateway is publishing the reconciled workspace."
        : row.identity_source === "personal"
          ? "My GitHub publication was accepted for the selected account and workspace."
          : "Publication was accepted. Finish the turn so the Gateway can reconcile and publish the workspace.",
  };
}

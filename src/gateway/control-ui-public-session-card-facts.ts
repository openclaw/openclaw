import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveAgentIdentity } from "../agents/identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProjectedAgentRunProgressState } from "../infra/agent-run-registry.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type { ControlUiSessionPullRequest } from "./control-ui-contract.js";
import type { PublicSessionCard } from "./control-ui-public-session-card-render.js";
import { resolveProjectedControlUiSessionPrTarget } from "./control-ui-session-pr-read.js";
import type { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import type { MaterializedRow } from "./session-row-projection-record.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { projectGatewaySessionRunState } from "./session-utils-display.js";

export type PublicSessionCardFacts = Pick<
  PublicSessionCard,
  "agentName" | "status" | "durationMinutes" | "repoSlug" | "worktree"
>;

const PR_STATES = {
  merged: "Merged",
  open: "Open",
  draft: "Draft",
  closed: "Closed",
} as const;

function cardText(value: string | undefined, limit: number): string | undefined {
  const text = value && truncateUtf16Safe(redactToolPayloadText(value), limit).trim();
  return text || undefined;
}

function checkSummary(checks: ControlUiSessionPullRequest["checks"]): string | undefined {
  if (!checks) {
    return undefined;
  }
  return (
    [
      checks.passed ? `${checks.passed} passed` : "",
      checks.failed ? `${checks.failed} failed` : "",
      checks.running ? `${checks.running} running` : "",
      checks.skipped ? `${checks.skipped} skipped` : "",
    ]
      .filter(Boolean)
      .join(" · ") || undefined
  );
}

/** The caller admits publication; this projects only its recorded and already cached facts. */
export function resolvePublicSessionCardFacts(params: {
  cfg: OpenClawConfig;
  record: MaterializedRow;
  rowContext: Pick<
    SessionListRowContext,
    "subagentRuns" | "projectedAgentRuns" | "projectedSubagentActivity"
  >;
  pullRequests?: Pick<
    ReturnType<typeof createControlUiSessionPullRequestSubscriptions>,
    "readPrepared"
  >;
  now?: number;
}): PublicSessionCardFacts {
  const { cfg, record, rowContext } = params;
  const { entry } = record;
  const now = params.now ?? Date.now();
  const temporal = projectGatewaySessionRunState({
    key: record.key,
    entry,
    now,
    rowContext: { ...rowContext, subagentRuns: rowContext.subagentRuns.atTime(now) },
  }).fields;
  const active = resolveProjectedAgentRunProgressState({
    sessionKeys: [record.key],
    sessionId: entry.sessionId,
    agentId: record.agentId,
    index: rowContext.projectedAgentRuns,
  });
  const running =
    active !== undefined ||
    temporal.hasActiveSubagentRun === true ||
    temporal.status === "running" ||
    temporal.status === "queued";
  const status = running
    ? "Running"
    : temporal.status === "done"
      ? "Done"
      : temporal.status !== undefined
        ? "Failed"
        : undefined;
  const startedAt = temporal.startedAt ?? entry.sessionStartedAt;
  const durationMs =
    temporal.runtimeMs ??
    (startedAt !== undefined && (temporal.endedAt !== undefined || running)
      ? (temporal.endedAt ?? now) - startedAt
      : undefined);
  const agentName = cardText(resolveAgentIdentity(cfg, record.agentId)?.name, 80);
  const target =
    entry.worktree || entry.projectId
      ? resolveProjectedControlUiSessionPrTarget(cfg, record)
      : undefined;
  // A cold public card must never discover a checkout or start a GitHub request.
  const snapshot = target ? params.pullRequests?.readPrepared(target, () => false) : undefined;
  const branch = cardText(entry.worktree?.branch, 180);
  const branchFacts =
    snapshot?.branch?.branch === entry.worktree?.branch ? snapshot?.branch : undefined;
  const pullRequest = snapshot?.pullRequests.find((pull) => pull.branch === entry.worktree?.branch);
  const repository = snapshot?.repository ?? branchFacts ?? pullRequest;
  const repoSlug = repository ? cardText(`${repository.owner}/${repository.repo}`, 160) : undefined;
  const additions = branchFacts?.additions ?? pullRequest?.additions;
  const deletions = branchFacts?.deletions ?? pullRequest?.deletions;
  const files = branchFacts?.changedFiles ?? pullRequest?.changedFiles;
  const checks = checkSummary(pullRequest?.checks);
  return {
    ...(agentName ? { agentName } : {}),
    ...(status ? { status } : {}),
    ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMinutes: Math.round(durationMs / 60_000) }
      : {}),
    ...(repoSlug ? { repoSlug } : {}),
    ...(branch
      ? {
          worktree: {
            branch,
            ...(additions !== undefined ? { additions } : {}),
            ...(deletions !== undefined ? { deletions } : {}),
            ...(files !== undefined ? { files } : {}),
            ...(pullRequest ? { prState: PR_STATES[pullRequest.state] } : {}),
            ...(checks ? { checks } : {}),
          },
        }
      : {}),
  };
}

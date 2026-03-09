import { listDescendantRunsForRequester } from "../../agents/subagent-registry.js";
import { readLatestAssistantReply } from "../../agents/tools/agent-step.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { callGateway } from "../../gateway/call.js";

const FAST_TEST_MODE = process.env.OPENCLAW_TEST_FAST === "1";

const CRON_SUBAGENT_WAIT_MIN_MS = FAST_TEST_MODE ? 10 : 30_000;
const CRON_SUBAGENT_FINAL_REPLY_GRACE_MS = FAST_TEST_MODE ? 50 : 5_000;
const CRON_SUBAGENT_GRACE_POLL_MS = FAST_TEST_MODE ? 8 : 200;

const SUBAGENT_FOLLOWUP_HINTS = [
  "subagent spawned",
  "spawned a subagent",
  "auto-announce when done",
  "both subagents are running",
  "wait for them to report back",
] as const;

const INTERIM_CRON_HINTS = [
  "on it",
  "pulling everything together",
  "give me a few",
  "give me a few min",
  "few minutes",
  "let me compile",
  "i'll gather",
  "i will gather",
  "working on it",
  "retrying now",
  "should be about",
  "should have your summary",
  "it'll auto-announce when done",
  "it will auto-announce when done",
  ...SUBAGENT_FOLLOWUP_HINTS,
] as const;

function normalizeHintText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isLikelyInterimCronMessage(value: string): boolean {
  const normalized = normalizeHintText(value);
  if (!normalized) {
    // Empty text after payload filtering means the agent either returned
    // NO_REPLY (deliberately silent) or produced no deliverable content.
    // Do not treat this as an interim acknowledgement that needs a rerun.
    return false;
  }
  const words = normalized.split(" ").filter(Boolean).length;
  return words <= 45 && INTERIM_CRON_HINTS.some((hint) => normalized.includes(hint));
}

export function expectsSubagentFollowup(value: string): boolean {
  const normalized = normalizeHintText(value);
  return Boolean(normalized && SUBAGENT_FOLLOWUP_HINTS.some((hint) => normalized.includes(hint)));
}

export async function readDescendantSubagentFallbackReply(params: {
  sessionKey: string;
  runStartedAt: number;
}): Promise<string | undefined> {
  const descendants = listDescendantRunsForRequester(params.sessionKey)
    .filter(
      (entry) =>
        typeof entry.endedAt === "number" &&
        entry.endedAt >= params.runStartedAt &&
        entry.childSessionKey.trim().length > 0,
    )
    .toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  if (descendants.length === 0) {
    return undefined;
  }

  const latestByChild = new Map<string, (typeof descendants)[number]>();
  for (const entry of descendants) {
    const childKey = entry.childSessionKey.trim();
    if (!childKey) {
      continue;
    }
    const current = latestByChild.get(childKey);
    if (!current || (entry.endedAt ?? 0) >= (current.endedAt ?? 0)) {
      latestByChild.set(childKey, entry);
    }
  }

  const replies: string[] = [];
  const latestRuns = [...latestByChild.values()]
    .toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    .slice(-4);
  for (const entry of latestRuns) {
    let reply = (await readLatestAssistantReply({ sessionKey: entry.childSessionKey }))?.trim();
    // Fall back to the registry's frozen result text when the session transcript
    // is unavailable (e.g. child session already deleted by announce cleanup).
    if (!reply && typeof entry.frozenResultText === "string" && entry.frozenResultText.trim()) {
      reply = entry.frozenResultText.trim();
    }
    if (!reply || reply.toUpperCase() === SILENT_REPLY_TOKEN.toUpperCase()) {
      continue;
    }
    replies.push(reply);
  }
  if (replies.length === 0) {
    return undefined;
  }
  if (replies.length === 1) {
    return replies[0];
  }
  return replies.join("\n\n");
}

/**
 * Waits for descendant subagents to complete using a push-based approach:
 * each active descendant run is awaited via `agent.wait` (gateway RPC) instead
 * of a busy-poll loop.  After all active runs settle, a short grace period
 * polls the cron agent's session for a post-orchestration synthesis message.
 */
export async function waitForDescendantSubagentSummary(params: {
  sessionKey: string;
  initialReply?: string;
  timeoutMs: number;
  observedActiveDescendants?: boolean;
}): Promise<string | undefined> {
  const initialReply = params.initialReply?.trim();
  const deadline = Date.now() + Math.max(CRON_SUBAGENT_WAIT_MIN_MS, Math.floor(params.timeoutMs));

  // Snapshot the currently active descendant run IDs.
  const getActiveRuns = () =>
    listDescendantRunsForRequester(params.sessionKey).filter(
      (entry) => typeof entry.endedAt !== "number",
    );

  const initialActiveRuns = getActiveRuns();
  const sawActiveDescendants =
    params.observedActiveDescendants === true || initialActiveRuns.length > 0;

  if (!sawActiveDescendants) {
    // No active descendants and none were observed before the call – nothing to wait for.
    return initialReply;
  }

  // --- Push-based wait for all active descendants ---
  // We iterate in case first-level descendants spawn their own subagents while
  // we wait, so new active runs can appear between rounds.
  let pendingRunIds = new Set<string>(initialActiveRuns.map((e) => e.runId));

  while (pendingRunIds.size > 0 && Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    // Wait for all currently pending runs concurrently.  If any fails or times
    // out, allSettled absorbs the error so we proceed to the next iteration.
    await Promise.allSettled(
      [...pendingRunIds].map((runId) =>
        callGateway<{ status?: string }>({
          method: "agent.wait",
          params: { runId, timeoutMs: remainingMs },
          timeoutMs: remainingMs + 2_000,
        }).catch(() => undefined),
      ),
    );

    // Refresh: check for newly created active descendants (e.g. spawned by
    // the runs that just finished) and keep looping if any exist.
    pendingRunIds = new Set<string>(getActiveRuns().map((e) => e.runId));
  }

  // --- Grace period: wait for the cron agent's synthesis ---
  // After the subagent announces fire and the cron agent processes them, it
  // produces a new assistant message.  Poll briefly (bounded by
  // CRON_SUBAGENT_FINAL_REPLY_GRACE_MS) to capture that synthesis.
  const gracePeriodDeadline = Math.min(Date.now() + CRON_SUBAGENT_FINAL_REPLY_GRACE_MS, deadline);

  while (Date.now() < gracePeriodDeadline) {
    const latest = (await readLatestAssistantReply({ sessionKey: params.sessionKey }))?.trim();
    if (
      latest &&
      latest.toUpperCase() !== SILENT_REPLY_TOKEN.toUpperCase() &&
      (latest !== initialReply || !isLikelyInterimCronMessage(latest))
    ) {
      return latest;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, CRON_SUBAGENT_GRACE_POLL_MS));
  }

  // Final read after grace period expires.
  const latest = (await readLatestAssistantReply({ sessionKey: params.sessionKey }))?.trim();
  if (
    latest &&
    latest.toUpperCase() !== SILENT_REPLY_TOKEN.toUpperCase() &&
    (latest !== initialReply || !isLikelyInterimCronMessage(latest))
  ) {
    return latest;
  }

  return undefined;
}

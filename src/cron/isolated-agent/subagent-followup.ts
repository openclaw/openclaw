import {
  countActiveDescendantRuns,
  listDescendantRunsForRequester,
} from "../../agents/subagent-registry.js";
import { readLatestAssistantReply } from "../../agents/tools/agent-step.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
const CRON_SUBAGENT_WAIT_POLL_MS = 500;
const CRON_SUBAGENT_WAIT_MIN_MS = 30_000;
const CRON_SUBAGENT_FINAL_REPLY_GRACE_MS = 5_000;
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
    return true;
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

export async function waitForDescendantSubagentSummary(params: {
  sessionKey: string;
  initialReply?: string;
  timeoutMs: number;
  observedActiveDescendants?: boolean;
}): Promise<string | undefined> {
  const initialReply = params.initialReply?.trim();
  const deadline = Date.now() + Math.max(CRON_SUBAGENT_WAIT_MIN_MS, Math.floor(params.timeoutMs));
  let sawActiveDescendants = params.observedActiveDescendants === true;
  let drainedAtMs: number | undefined;
  while (Date.now() < deadline) {
    const activeDescendants = countActiveDescendantRuns(params.sessionKey);
    if (activeDescendants > 0) {
      sawActiveDescendants = true;
      drainedAtMs = undefined;
      await new Promise((resolve) => setTimeout(resolve, CRON_SUBAGENT_WAIT_POLL_MS));
      continue;
    }
    if (!sawActiveDescendants) {
      return initialReply;
    }
    if (!drainedAtMs) {
      drainedAtMs = Date.now();
    }
    const latest = (await readLatestAssistantReply({ sessionKey: params.sessionKey }))?.trim();
    if (
      latest &&
      latest.toUpperCase() !== SILENT_REPLY_TOKEN.toUpperCase() &&
      (latest !== initialReply || !isLikelyInterimCronMessage(latest))
    ) {
      return latest;
    }
    if (Date.now() - drainedAtMs >= CRON_SUBAGENT_FINAL_REPLY_GRACE_MS) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, CRON_SUBAGENT_WAIT_POLL_MS));
  }
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

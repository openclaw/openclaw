import {
  countActiveDescendantRuns,
  listDescendantRunsForRequester,
} from "../../agents/subagent-registry.js";
import { readLatestAssistantReply } from "../../agents/tools/agent-step.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";

const CRON_SUBAGENT_WAIT_POLL_MS = 500;
const CRON_SUBAGENT_WAIT_MIN_MS = 30_000;
const CRON_SUBAGENT_FINAL_REPLY_GRACE_MS = 5_000;

export function isLikelyInterimCronMessage(value: string): boolean {
  const text = value.trim();
  if (!text) {
    return true;
  }
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const words = normalized.split(" ").filter(Boolean).length;
  const interimHints = [
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
    "subagent spawned",
    "spawned a subagent",
    "it'll auto-announce when done",
    "it will auto-announce when done",
    "auto-announce when done",
    "both subagents are running",
    "wait for them to report back",
  ];
  return words <= 45 && interimHints.some((hint) => normalized.includes(hint));
}

export function expectsSubagentFollowup(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return false;
  }
  const hints = [
    "subagent spawned",
    "spawned a subagent",
    "auto-announce when done",
    "both subagents are running",
    "wait for them to report back",
  ];
  return hints.some((hint) => normalized.includes(hint));
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
    const reply = (await readLatestAssistantReply({ sessionKey: entry.childSessionKey }))?.trim();
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

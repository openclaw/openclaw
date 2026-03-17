import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import {
  collectMainSessionSystemEventTokens,
  MAIN_SESSION_SYSTEM_EVENT_FALLBACK_TOKEN,
} from "../cron/main-session-system-event.js";

// Main-session cron wakes should stay internal-only. Keep only short safe
// tokens in the prompt and redact richer event text.
export function buildCronEventPrompt(
  pendingEvents: string[],
  _opts?: {
    deliverToUser?: boolean;
  },
): string {
  const tokens = collectMainSessionSystemEventTokens(pendingEvents);
  const lines = ["SYSTEM_WAKE source=cron"];
  for (const token of tokens) {
    if (token === MAIN_SESSION_SYSTEM_EVENT_FALLBACK_TOKEN) {
      continue;
    }
    lines.push(`token=${token}`);
  }
  lines.push("Reply HEARTBEAT_OK unless session context requires follow-up.");
  return lines.join("\n");
}

export function buildExecEventPrompt(opts?: { deliverToUser?: boolean }): string {
  const deliverToUser = opts?.deliverToUser ?? true;
  if (!deliverToUser) {
    return (
      "An async command you ran earlier has completed. The result is shown in the system messages above. " +
      "Handle the result internally. Do not relay it to the user unless explicitly requested."
    );
  }
  return (
    "An async command you ran earlier has completed. The result is shown in the system messages above. " +
    "Please relay the command output to the user in a helpful way. If the command succeeded, share the relevant output. " +
    "If it failed, explain what went wrong."
  );
}

const HEARTBEAT_OK_PREFIX = HEARTBEAT_TOKEN.toLowerCase();

// Detect heartbeat-specific noise so cron reminders don't trigger on non-reminder events.
function isHeartbeatAckEvent(evt: string): boolean {
  const trimmed = evt.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(HEARTBEAT_OK_PREFIX)) {
    return false;
  }
  const suffix = lower.slice(HEARTBEAT_OK_PREFIX.length);
  if (suffix.length === 0) {
    return true;
  }
  return !/[a-z0-9_]/.test(suffix[0]);
}

function isHeartbeatNoiseEvent(evt: string): boolean {
  const lower = evt.trim().toLowerCase();
  if (!lower) {
    return false;
  }
  return (
    isHeartbeatAckEvent(lower) ||
    lower.includes("heartbeat poll") ||
    lower.includes("heartbeat wake")
  );
}

export function isExecCompletionEvent(evt: string): boolean {
  return evt.toLowerCase().includes("exec finished");
}

// Returns true when a system event should be treated as real cron reminder content.
export function isCronSystemEvent(evt: string) {
  if (!evt.trim()) {
    return false;
  }
  return !isHeartbeatNoiseEvent(evt) && !isExecCompletionEvent(evt);
}

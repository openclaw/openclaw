import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import type { SessionReplyLanguage } from "./session-language.js";

// Build a dynamic prompt for cron events by embedding the actual event content.
// This ensures the model sees the reminder text directly instead of relying on
// "shown in the system messages above" which may not be visible in context.
export function buildCronEventPrompt(
  pendingEvents: string[],
  opts?: {
    deliverToUser?: boolean;
    replyLanguage?: SessionReplyLanguage;
  },
): string {
  const deliverToUser = opts?.deliverToUser ?? true;
  const replyLanguage = opts?.replyLanguage;
  const eventText = pendingEvents.join("\n").trim();
  if (!eventText) {
    if (!deliverToUser) {
      return (
        "A scheduled cron event was triggered, but no event content was found. " +
        "Handle this internally and reply HEARTBEAT_OK when nothing needs user-facing follow-up."
      );
    }
    return (
      "A scheduled cron event was triggered, but no event content was found. " +
      "Reply HEARTBEAT_OK."
    );
  }
  if (!deliverToUser) {
    return (
      "A scheduled reminder has been triggered. The reminder content is:\n\n" +
      eventText +
      "\n\nHandle this reminder internally. Do not relay it to the user unless explicitly requested."
    );
  }
  if (replyLanguage === "zh-Hans") {
    return (
      "系统触发了一条定时提醒。提醒内容如下：\n\n" +
      eventText +
      "\n\n请用简体中文把这条提醒清楚转达给用户，保持简洁、自然。"
    );
  }
  return (
    "A scheduled reminder has been triggered. The reminder content is:\n\n" +
    eventText +
    "\n\nPlease relay this reminder to the user clearly and naturally in English."
  );
}

export function buildExecEventPrompt(opts?: {
  deliverToUser?: boolean;
  replyLanguage?: SessionReplyLanguage;
}): string {
  const deliverToUser = opts?.deliverToUser ?? true;
  const replyLanguage = opts?.replyLanguage;
  if (!deliverToUser) {
    return (
      "An async command you ran earlier has completed. The result is shown in the system messages above. " +
      "Handle the result internally. Do not relay it to the user unless explicitly requested."
    );
  }
  if (replyLanguage === "zh-Hans") {
    return (
      "你之前运行的异步命令已经完成，结果已显示在上方系统消息中。 " +
      "请用简体中文把结果清楚告诉用户：成功就给出关键结果，失败就简要说明原因。"
    );
  }
  return (
    "An async command you ran earlier has completed. The result is shown in the system messages above. " +
    "Please relay the result clearly in English. If it succeeded, share the key output. If it failed, explain what went wrong."
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

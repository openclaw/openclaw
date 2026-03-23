const MAIN_SESSION_SYSTEM_EVENT_MAX_LEN = 80;
const MAIN_SESSION_SYSTEM_EVENT_MAX_WORDS = 12;

const BLOCKED_MAIN_SESSION_PATTERNS = [
  /\brelay\b/i,
  /\bremind(?:er)?\b/i,
  /\brecent context\b/i,
  /\bfriendly\b/i,
  /\binspect the current\b/i,
  /\bprogress update\b/i,
  /\b(send|tell|message)\b.{0,32}\buser\b/i,
  /\buser\b.{0,32}\b(send|tell|message)\b/i,
] as const;

export const MAIN_SESSION_SYSTEM_EVENT_ERROR =
  'cron main-session systemEvent text must be a short internal wake token; use sessionTarget="isolated" with payload.kind="agentTurn" for rich reminders or follow-up prose';

export const MAIN_SESSION_SYSTEM_EVENT_FALLBACK_TOKEN = "cron wake";

export function normalizeMainSessionSystemEventText(raw: string): string {
  return raw.trim();
}

export function isSafeMainSessionSystemEventText(raw: string): boolean {
  const text = normalizeMainSessionSystemEventText(raw);
  if (!text) {
    return false;
  }
  if (text.length > MAIN_SESSION_SYSTEM_EVENT_MAX_LEN) {
    return false;
  }
  if (/[\r\n]/.test(text)) {
    return false;
  }
  if (/[.!?]/.test(text)) {
    return false;
  }
  const words = text.split(/\s+/u).filter(Boolean);
  if (words.length > MAIN_SESSION_SYSTEM_EVENT_MAX_WORDS) {
    return false;
  }
  return !BLOCKED_MAIN_SESSION_PATTERNS.some((pattern) => pattern.test(text));
}

export function assertSafeMainSessionSystemEventText(raw: string): string {
  const text = normalizeMainSessionSystemEventText(raw);
  if (!isSafeMainSessionSystemEventText(text)) {
    throw new Error(MAIN_SESSION_SYSTEM_EVENT_ERROR);
  }
  return text;
}

export function toMainSessionSystemEventToken(raw: string): string | undefined {
  const text = normalizeMainSessionSystemEventText(raw);
  if (!text) {
    return undefined;
  }
  return isSafeMainSessionSystemEventText(text) ? text : MAIN_SESSION_SYSTEM_EVENT_FALLBACK_TOKEN;
}

export function collectMainSessionSystemEventTokens(events: string[]): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const event of events) {
    const token = toMainSessionSystemEventToken(event);
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

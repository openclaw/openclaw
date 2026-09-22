// Pure stop-word policy shared by inbound command routing and browser admission.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const ABORT_TRIGGERS = new Set([
  "stop",
  "esc",
  "abort",
  "exit",
  "interrupt",
  "detente",
  "deten",
  "detén",
  "arrete",
  "arrête",
  "停止",
  "停下来",
  "暂停",
  "やめて",
  "止めて",
  "रुको",
  "توقف",
  "стоп",
  "остановись",
  "останови",
  "остановить",
  "прекрати",
  "halt",
  "anhalten",
  "aufhören",
  "hoer auf",
  "stopp",
  "pare",
  "stop openclaw",
  "openclaw stop",
  "stop action",
  "stop current action",
  "stop run",
  "stop current run",
  "stop agent",
  "stop the agent",
  "stop don't do anything",
  "stop dont do anything",
  "stop do not do anything",
  "stop doing anything",
  "do not do that",
  "please stop",
  "stop please",
]);
const TRAILING_ABORT_PUNCTUATION_RE = /[.!?！？…,，。;；:：'"’”)\]}]+$/u;

export function normalizeAbortTriggerText(text: string): string {
  return normalizeLowercaseStringOrEmpty(text)
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .replace(TRAILING_ABORT_PUNCTUATION_RE, "")
    .trim();
}

export function isAbortTrigger(text?: string): boolean {
  if (!text) {
    return false;
  }
  const normalized = normalizeAbortTriggerText(text);
  return ABORT_TRIGGERS.has(normalized);
}

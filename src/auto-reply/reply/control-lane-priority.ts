import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { QueueMode } from "./queue.js";

export type DirectControlLanePriority = {
  queueMode: QueueMode;
  reason: "manual_override" | "urgent_need" | "correction";
};

const MANUAL_WORD_RE = /\b(manuell|selbst|von hand|händisch|haendisch|manual(?:ly)?)\b/u;
const MANUAL_ACTION_RE =
  /\b(ein(?:geschaltet|geschalten|gemacht|gesteckt)?|aus(?:geschaltet|gemacht|gesteckt)?|angeschaltet|abgeschaltet|gestartet|gestoppt|freigegeben|blockiert|geladen|angeschlossen|abgezogen|eingesteckt|ausgesteckt)\b/u;
const URGENCY_RE =
  /\b(ich\s+)?(brauch(?:e|en)?|benötige|benoetige|muss|musst|notwendig|wichtig)\b[\s\S]{0,80}\b(jetzt|sofort|gerade|aktuell|dringend)\b/u;
const URGENCY_REVERSED_RE =
  /\b(jetzt|sofort|gerade|aktuell|dringend)\b[\s\S]{0,80}\b(benötige|benoetige|brauch(?:e|en)?|muss|musst)\b/u;
const CORRECTION_RE =
  /\b(stimmt nicht|falsch|das ist falsch|nein\b|nicht so|lass das|auf keinen fall|bitte nicht|tu das nicht|mach das nicht)\b/u;

function normalizeControlLaneText(text: string): string {
  return normalizeLowercaseStringOrEmpty(text)
    .replace(/[’`]/g, "'")
    .replace(/[.,!?！？…,，。;；:：'"“”()[\]{}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveDirectControlLanePriority(params: {
  text?: string | null;
  chatType?: string | null;
  isHeartbeat?: boolean;
  hasMedia?: boolean;
}): DirectControlLanePriority | undefined {
  if (params.isHeartbeat === true || params.hasMedia === true) {
    return undefined;
  }
  if (normalizeChatType(params.chatType ?? undefined) !== "direct") {
    return undefined;
  }
  const text = normalizeControlLaneText(params.text ?? "");
  if (!text) {
    return undefined;
  }
  if (MANUAL_WORD_RE.test(text) && MANUAL_ACTION_RE.test(text)) {
    return { queueMode: "interrupt", reason: "manual_override" };
  }
  if (URGENCY_RE.test(text) || URGENCY_REVERSED_RE.test(text)) {
    return { queueMode: "interrupt", reason: "urgent_need" };
  }
  if (CORRECTION_RE.test(text)) {
    return { queueMode: "interrupt", reason: "correction" };
  }
  return undefined;
}

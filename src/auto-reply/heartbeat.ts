/** Historical transcript and token recognition. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { escapeRegExp } from "../shared/regexp.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN, isSilentReplyPayloadText } from "./tokens.js";

// Historical prompt bytes are retained for saved transcript recognition.
// Keep it tight and avoid encouraging the model to invent/rehash "open loops" from prior chat context.
const HEARTBEAT_CRON_TASK_GUIDANCE =
  "Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch.";
const HEARTBEAT_CONTEXT_PROMPT = `Follow the heartbeat monitor scratch context when provided. ${HEARTBEAT_CRON_TASK_GUIDANCE} Do not infer or repeat old tasks from prior chats.`;
/** @deprecated Ordinary automations supply their own instructions. */
export const HEARTBEAT_PROMPT = `${HEARTBEAT_CONTEXT_PROMPT} If nothing needs attention, reply ${SILENT_REPLY_TOKEN}.`;
export const HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS =
  "Use heartbeat_respond to report the wake outcome. Set notify=false when nothing needs the user's attention. Set notify=true with notificationText only when the user should be interrupted.";
// A fallback backend may lack the direct-only tool; preserve both quiet and alert outcomes.
const HEARTBEAT_RESPONSE_TOOL_FALLBACK_INSTRUCTIONS = `If the heartbeat_respond tool is not available in this run, reply ${SILENT_REPLY_TOKEN} when nothing needs the user's attention; when the user should be interrupted, reply with only the alert text instead of a prose report.`;
export const HEARTBEAT_RESPONSE_TOOL_PROMPT = `${HEARTBEAT_CONTEXT_PROMPT} ${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS} ${HEARTBEAT_RESPONSE_TOOL_FALLBACK_INSTRUCTIONS}`;
export const INTERNAL_WAKE_TRANSCRIPT_PROMPTS = {
  heartbeat: "[OpenClaw heartbeat poll]",
  exec: "[OpenClaw exec completion]\nDisable automatic completion turns with tools.exec.notifyOnExit=false; check per-agent overrides. Background exec and process poll remain available.",
  // Saved transcripts still contain the marker without the disablement hint.
  legacyExec: "[OpenClaw exec completion]",
  cron: "[OpenClaw cron wake]",
  event: "[OpenClaw session event]",
} as const;
export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

/** Reconstructs historical response-tool prompts for saved transcript recognition. */
export function resolveHeartbeatPromptForResponseTool(raw?: string): string {
  const prompt = normalizeOptionalString(raw);
  if (!prompt) {
    return HEARTBEAT_RESPONSE_TOOL_PROMPT;
  }
  let resolved = prompt;
  for (const instructions of [
    HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS,
    HEARTBEAT_RESPONSE_TOOL_FALLBACK_INSTRUCTIONS,
  ]) {
    if (!resolved.includes(instructions)) {
      resolved = `${resolved}\n\n${instructions}`;
    }
  }
  return resolved;
}

type StripHeartbeatMode = "heartbeat" | "message";
const HEARTBEAT_TRAILING_TOKEN_RE = new RegExp(`${escapeRegExp(HEARTBEAT_TOKEN)}[^\\w]{0,4}$`);

function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { text: "", didStrip: false };
  }

  const token = HEARTBEAT_TOKEN;
  if (!text.includes(token)) {
    return { text, didStrip: false };
  }

  let didStrip = false;
  while (true) {
    const next = text.trim();
    if (next.startsWith(token)) {
      text = next.slice(token.length).trimStart();
      didStrip = true;
      continue;
    }
    // Strip the token when it appears at the end of the text.
    // Also strip up to 4 trailing non-word characters the model may have appended
    // (e.g. ".", "!!!", "---"). Keep trailing punctuation only when real
    // sentence text exists before the token.
    if (HEARTBEAT_TRAILING_TOKEN_RE.test(next)) {
      const idx = next.lastIndexOf(token);
      const before = next.slice(0, idx).trimEnd();
      const after = next.slice(idx + token.length).trimStart();
      text = `${before}${after}`.trimEnd();
      didStrip = true;
    } else {
      break;
    }
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  return { text: collapsed, didStrip };
}

/** Strips HEARTBEAT_OK acknowledgements and decides whether visible notification is needed. */
export function stripHeartbeatToken(
  raw?: string,
  opts: { mode?: StripHeartbeatMode; maxAckChars?: number } = {},
) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  // Markup cleanup inserts spaces or removes edge wrappers; it cannot create this token.
  if (!trimmed.includes(HEARTBEAT_TOKEN)) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  const mode: StripHeartbeatMode = opts.mode ?? "message";
  const maxAckCharsRaw = opts.maxAckChars;
  const parsedAckChars =
    typeof maxAckCharsRaw === "string" ? Number(maxAckCharsRaw) : maxAckCharsRaw;
  const maxAckChars = Math.max(
    0,
    typeof parsedAckChars === "number" && Number.isFinite(parsedAckChars)
      ? parsedAckChars
      : DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  // Normalize lightweight markup so HEARTBEAT_OK wrapped in HTML/Markdown
  // (e.g., <b>HEARTBEAT_OK</b> or **HEARTBEAT_OK**) still strips.
  const stripMarkup = (text: string) =>
    text
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/^[*`~_]+/, "")
      .replace(/[*`~_]+$/, "");

  const trimmedNormalized = stripMarkup(trimmed);

  const strippedOriginal = stripTokenAtEdges(trimmed);
  const strippedNormalized = stripTokenAtEdges(trimmedNormalized);
  const picked =
    strippedOriginal.didStrip && strippedOriginal.text ? strippedOriginal : strippedNormalized;
  if (!picked.didStrip) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  if (!picked.text) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  const rest = picked.text.trim();
  if (mode === "heartbeat" && rest.length <= maxAckChars) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  return { shouldSkip: false, text: rest, didStrip: true };
}

/** Recognizes canonical silent replies and backwards-compatible heartbeat acknowledgements. */
export function isHeartbeatAcknowledgementText(
  text: string | undefined,
  maxAckChars = DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
): boolean {
  return (
    isSilentReplyPayloadText(text) ||
    stripHeartbeatToken(text, { mode: "heartbeat", maxAckChars }).shouldSkip
  );
}

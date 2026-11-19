import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { escapeRegExp } from "../shared/regexp.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "./tokens.js";

// Default heartbeat prompt (used when config.agents.defaults.heartbeat.prompt is unset).
// Keep it tight and avoid encouraging the model to invent/rehash "open loops" from prior chat context.
const HEARTBEAT_CRON_TASK_GUIDANCE =
  "Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch.";
const HEARTBEAT_CONTEXT_PROMPT = `Follow the heartbeat monitor scratch context when provided. ${HEARTBEAT_CRON_TASK_GUIDANCE} Do not infer or repeat old tasks from prior chats.`;
/** Default prompt for heartbeat turns when config does not override it. */
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

/** Resolves heartbeat prompt text and guarantees heartbeat_respond tool instructions are present. */
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
/** Heartbeats accept only strict token prefixes with at least four characters. */
function isTruncatedSilentReplyText(text: string | undefined): boolean {
  const candidate = text?.trim().toUpperCase() ?? "";
  return (
    candidate.length >= 4 &&
    candidate.length < SILENT_REPLY_TOKEN.length &&
    SILENT_REPLY_TOKEN.startsWith(candidate)
  );
}

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

  return { text, didStrip };
}

/** Strips HEARTBEAT_OK acknowledgements and decides whether visible notification is needed. */
export function stripHeartbeatToken(
  raw?: string,
  opts: { mode?: StripHeartbeatMode; maxAckChars?: number; allowTruncated?: boolean } = {},
) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  const mode: StripHeartbeatMode = opts.mode ?? "message";
  if (
    mode === "heartbeat" &&
    opts.allowTruncated !== false &&
    isTruncatedSilentReplyText(trimmed)
  ) {
    return { shouldSkip: true, text: "", didStrip: true };
  }
  // Markup cleanup inserts spaces or removes edge wrappers; it cannot create this token.
  if (!trimmed.includes(HEARTBEAT_TOKEN)) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  const maxAckCharsRaw = opts.maxAckChars;
  const maxAckChars = Math.max(
    0,
    maxAckCharsRaw !== undefined && Number.isFinite(maxAckCharsRaw)
      ? maxAckCharsRaw
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

  const rest = picked.text.trim();
  const shouldSkip = !picked.text || (mode === "heartbeat" && rest.length <= maxAckChars);
  return { shouldSkip, text: shouldSkip ? "" : rest, didStrip: true };
}

/** Truncated acknowledgements require established heartbeat context. */
export function isHeartbeatAcknowledgementText(
  text: string | undefined,
  maxAckChars = DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  allowTruncated = false,
): boolean {
  return stripHeartbeatToken(text, { mode: "heartbeat", maxAckChars, allowTruncated }).shouldSkip;
}

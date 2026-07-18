import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Session auto-titles use the shared utility-model completion path.
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isAcpSessionKey,
  isCronRunSessionKey,
  parseAgentSessionKey,
} from "../sessions/session-key-utils.js";

const SESSION_AUTO_TITLE_MAX_CHARS = 60;
const SESSION_AUTO_TITLE_SOURCE_MAX_CHARS = 1_000;
const SESSION_AUTO_TITLE_PROMPT =
  "Generate a concise session title (3-6 words, max 60 characters) from the user's first message. Use the same language as the message. No emoji. Return only the title.";

// One title attempt per session generation. Entries stay marked after
// completion so concurrent triggers (gateway chat.send and the reply pipeline)
// or a failed model call cannot spend a second utility request on the same
// session. The cap only bounds memory in long-lived gateways; evicted entries
// stay safe because sessions past their first turn fail the systemSent check.
const SESSION_AUTO_TITLE_ATTEMPTS_MAX = 4_096;
const sessionAutoTitleAttempts = new Set<string>();

function markSessionAutoTitleAttempt(requestKey: string): boolean {
  if (sessionAutoTitleAttempts.has(requestKey)) {
    return false;
  }
  sessionAutoTitleAttempts.add(requestKey);
  if (sessionAutoTitleAttempts.size > SESSION_AUTO_TITLE_ATTEMPTS_MAX) {
    const oldest = sessionAutoTitleAttempts.keys().next().value;
    if (oldest !== undefined) {
      sessionAutoTitleAttempts.delete(oldest);
    }
  }
  return true;
}

export function resetSessionAutoTitleAttemptsForTest(): void {
  sessionAutoTitleAttempts.clear();
}

function hasExplicitSessionName(entry: SessionEntry | undefined): boolean {
  return Boolean(
    entry?.label?.trim() ||
    entry?.displayName?.trim() ||
    entry?.subject?.trim() ||
    entry?.origin?.label?.trim(),
  );
}

export function isSessionAutoTitleCandidate(params: {
  sessionKey: string;
  userMessage: string;
}): boolean {
  const sourceText = params.userMessage.trim();
  if (!sourceText || sourceText.startsWith("/")) {
    return false;
  }
  // Cron runs have no human first turn and ACP sessions carry titles in their
  // own runtime metadata; both keep the deterministic derived title.
  return Boolean(
    parseAgentSessionKey(params.sessionKey) &&
    !isAcpSessionKey(params.sessionKey) &&
    !isCronRunSessionKey(params.sessionKey),
  );
}

function normalizeSessionAutoTitle(raw: string): string | null {
  const firstLine = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("```"));
  if (!firstLine) {
    return null;
  }
  const unwrapped = firstLine.replace(/^\s*(?:title\s*:\s*)?/i, "").replace(/^["'`]+|["'`]+$/g, "");
  const normalized = unwrapped.replace(/\s+/g, " ").trim();
  return normalized ? truncateUtf16Safe(normalized, SESSION_AUTO_TITLE_MAX_CHARS) : null;
}

export async function maybeGenerateSessionAutoTitle(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: SessionEntry | undefined;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  userMessage: string;
}): Promise<boolean> {
  const sourceText = params.userMessage.trim();
  if (
    !isSessionAutoTitleCandidate({
      sessionKey: params.sessionKey,
      userMessage: sourceText,
    }) ||
    hasExplicitSessionName(params.entry) ||
    params.entry?.systemSent === true ||
    params.entry?.sessionId !== params.sessionId
  ) {
    return false;
  }
  // Auto-titles run only on the utility model. An explicit empty utilityModel
  // ("") — or a provider without a declared small-model default — disables
  // generation entirely instead of letting the shared completion path fall
  // back to the primary model; the deterministic derived title remains.
  if (!resolveUtilityModelRefForAgent({ cfg: params.cfg, agentId: params.agentId })) {
    return false;
  }

  const requestKey = `${params.storePath}\0${params.sessionKey}\0${params.sessionId}`;
  if (!markSessionAutoTitleAttempt(requestKey)) {
    return false;
  }
  const generated = await generateConversationLabel({
    userMessage: truncateUtf16Safe(sourceText, SESSION_AUTO_TITLE_SOURCE_MAX_CHARS),
    prompt: SESSION_AUTO_TITLE_PROMPT,
    cfg: params.cfg,
    agentId: params.agentId,
    maxLength: SESSION_AUTO_TITLE_MAX_CHARS,
  });
  const displayName = generated ? normalizeSessionAutoTitle(generated) : null;
  if (!displayName) {
    return false;
  }

  let persisted = false;
  await updateSessionEntry(
    {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    (current) => {
      if (current.sessionId !== params.sessionId || hasExplicitSessionName(current)) {
        return null;
      }
      persisted = true;
      return { displayName };
    },
    { requireWriteSuccess: true },
  );
  return persisted;
}

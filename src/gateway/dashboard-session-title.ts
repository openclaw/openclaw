// Session titles use the shared utility-model completion path.
// Originally dashboard-only; generalized to support all session types.
import { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

const SESSION_TITLE_MAX_CHARS = 60;
const SESSION_TITLE_SOURCE_MAX_CHARS = 1_000;
const SESSION_TITLE_PROMPT =
  "Generate a concise session title (3-6 words, max 60 characters) from the user's first message. Use the same language as the message. No emoji. Return only the title.";

// One title request per first turn. Concurrent sends cannot race duplicate model
// calls or metadata writes while the initial agent run advances session state.
const sessionTitleRequests = new Set<string>();

export function hasExplicitSessionName(entry: SessionEntry | undefined): boolean {
  return Boolean(
    entry?.label?.trim() ||
    entry?.displayName?.trim() ||
    entry?.subject?.trim() ||
    entry?.origin?.label?.trim(),
  );
}

function isDashboardSessionKey(sessionKey: string): boolean {
  return parseAgentSessionKey(sessionKey)?.rest.startsWith("dashboard:") === true;
}

/**
 * Returns true if this session is a candidate for title generation.
 * For dashboard sessions, always a candidate (existing behavior).
 * For other sessions, requires isNewSession=true and autoTitle config enabled.
 */
export function isSessionTitleCandidate(params: {
  sessionKey: string;
  userMessage: string;
  isNewSession?: boolean;
  autoTitleEnabled?: boolean;
}): boolean {
  const sourceText = params.userMessage.trim();
  if (!sourceText || sourceText.startsWith("/")) {
    return false;
  }
  // Dashboard sessions always get titles (existing behavior).
  if (isDashboardSessionKey(params.sessionKey)) {
    return true;
  }
  // Non-dashboard sessions need isNewSession + autoTitle config.
  return Boolean(params.isNewSession && params.autoTitleEnabled);
}

/** @deprecated Use isSessionTitleCandidate instead. */
export const isDashboardSessionTitleCandidate = isSessionTitleCandidate;

export function normalizeSessionTitle(raw: string): string | null {
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
  return normalized ? normalized.slice(0, SESSION_TITLE_MAX_CHARS) : null;
}

/** @deprecated Use normalizeSessionTitle instead. */
export const normalizeDashboardSessionTitle = normalizeSessionTitle;

/**
 * Attempt to generate a session title from the user message.
 * Runs in the background — does not block the reply path.
 * Returns true if a title was persisted.
 *
 * Works for both dashboard sessions (always) and regular sessions
 * (when autoTitle config is enabled and it's the first turn).
 */
export async function maybeGenerateSessionTitle(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: SessionEntry | undefined;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  userMessage: string;
  /** When true, allows title generation for non-dashboard sessions. */
  autoTitleEnabled?: boolean;
}): Promise<boolean> {
  const sourceText = params.userMessage.trim();
  const isDashboard = isDashboardSessionKey(params.sessionKey);
  const autoTitleEnabled = isDashboard || params.autoTitleEnabled === true;

  if (
    !isSessionTitleCandidate({
      sessionKey: params.sessionKey,
      userMessage: sourceText,
      isNewSession: true,
      autoTitleEnabled,
    }) ||
    hasExplicitSessionName(params.entry) ||
    params.entry?.systemSent === true ||
    params.entry?.sessionId !== params.sessionId
  ) {
    return false;
  }

  const requestKey = `${params.storePath}\0${params.sessionKey}\0${params.sessionId}`;
  if (sessionTitleRequests.has(requestKey)) {
    return false;
  }
  sessionTitleRequests.add(requestKey);
  try {
    const generated = await generateConversationLabel({
      userMessage: sourceText.slice(0, SESSION_TITLE_SOURCE_MAX_CHARS),
      prompt: SESSION_TITLE_PROMPT,
      cfg: params.cfg,
      agentId: params.agentId,
      maxLength: SESSION_TITLE_MAX_CHARS,
    });
    const displayName = generated ? normalizeSessionTitle(generated) : null;
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
  } finally {
    sessionTitleRequests.delete(requestKey);
  }
}

/** @deprecated Use maybeGenerateSessionTitle instead. */
export const maybeGenerateDashboardSessionTitle = maybeGenerateSessionTitle;

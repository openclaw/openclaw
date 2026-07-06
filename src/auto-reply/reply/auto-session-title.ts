// Auto-generates concise session titles from the first user message,
// similar to ChatGPT/Gemini/Claude title-based session naming.
import { generateConversationLabel } from "./conversation-label-generator.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";

const AUTO_SESSION_TITLE_MAX_CHARS = 60;
const AUTO_SESSION_TITLE_SOURCE_MAX_CHARS = 1_000;
const AUTO_SESSION_TITLE_PROMPT =
  "Generate a concise session title (3-6 words, max 60 characters) from the user's first message. Use the same language as the message. No emoji. Return only the title.";

// Deduplicate concurrent title requests for the same session.
const pendingTitleRequests = new Set<string>();

function hasExplicitSessionName(entry: SessionEntry | undefined): boolean {
  return Boolean(
    entry?.label?.trim() ||
    entry?.displayName?.trim() ||
    entry?.subject?.trim() ||
    entry?.origin?.label?.trim(),
  );
}

function normalizeSessionTitle(raw: string): string | null {
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
  return normalized ? normalized.slice(0, AUTO_SESSION_TITLE_MAX_CHARS) : null;
}

/**
 * Returns true if this session is a candidate for auto-title generation:
 * - Has a session key and store path
 * - Is a new session (first turn)
 * - Has no explicit name set (label, displayName, subject, or origin label)
 * - Has a non-empty, non-command user message
 */
export function isAutoSessionTitleCandidate(params: {
  sessionKey: string;
  userMessage: string;
  isNewSession: boolean;
  entry?: SessionEntry;
}): boolean {
  if (!params.isNewSession) {
    return false;
  }
  const sourceText = params.userMessage.trim();
  if (!sourceText || sourceText.startsWith("/")) {
    return false;
  }
  if (hasExplicitSessionName(params.entry)) {
    return false;
  }
  return true;
}

/**
 * Attempt to auto-generate a session title from the first user message.
 * Runs in the background — does not block the reply path.
 * Returns true if a title was persisted.
 */
export async function maybeGenerateAutoSessionTitle(params: {
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
    !isAutoSessionTitleCandidate({
      sessionKey: params.sessionKey,
      userMessage: sourceText,
      isNewSession: true,
      entry: params.entry,
    })
  ) {
    return false;
  }

  // systemSent=true means the system prompt was already delivered, which means
  // this isn't truly the first user turn — skip to avoid duplicate titles.
  if (params.entry?.systemSent === true) {
    return false;
  }

  // Don't re-request if the session already moved past the initial sessionId.
  if (params.entry?.sessionId !== params.sessionId) {
    return false;
  }

  const requestKey = `${params.storePath}\0${params.sessionKey}\0${params.sessionId}`;
  if (pendingTitleRequests.has(requestKey)) {
    return false;
  }
  pendingTitleRequests.add(requestKey);
  try {
    const generated = await generateConversationLabel({
      userMessage: sourceText.slice(0, AUTO_SESSION_TITLE_SOURCE_MAX_CHARS),
      prompt: AUTO_SESSION_TITLE_PROMPT,
      cfg: params.cfg,
      agentId: params.agentId,
      maxLength: AUTO_SESSION_TITLE_MAX_CHARS,
    });
    const displayName = generated ? normalizeSessionTitle(generated) : null;
    if (!displayName) {
      logVerbose(`auto-session-title: failed to generate title for ${params.sessionKey}`);
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
        // Guard: only write if the session hasn't rotated and has no explicit name.
        if (
          current.sessionId !== params.sessionId ||
          hasExplicitSessionName(current)
        ) {
          return null;
        }
        persisted = true;
        return { displayName };
      },
      { requireWriteSuccess: true },
    );
    if (persisted) {
      logVerbose(`auto-session-title: set title "${displayName}" for ${params.sessionKey}`);
    }
    return persisted;
  } finally {
    pendingTitleRequests.delete(requestKey);
  }
}

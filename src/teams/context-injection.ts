/**
 * Message Injection
 * Converts pending inbox messages into XML for agent context
 */

import type { SessionEntry } from "../config/sessions/types.js";
import { readInboxMessages, clearInboxMessages } from "./inbox.js";
import type { TeamMessage } from "./types.js";

/**
 * Escape special characters for XML
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Resolve agent name from session key
 * Extracts the part before the first hyphen, or returns full key
 */
function resolveAgentName(sessionKey: string): string {
  const hyphenIndex = sessionKey.indexOf("-");
  return hyphenIndex > 0 ? sessionKey.substring(0, hyphenIndex) : sessionKey;
}

/**
 * Convert message to XML format
 * Handles both TeamMessage and plain object formats
 */
function messageToXml(message: TeamMessage | Record<string, unknown>): string {
  // Handle both TeamMessage format (with 'from') and test format (with 'sender')
  const msg = message as TeamMessage;
  const sender = msg.from || (message as { sender?: string }).sender || "unknown";
  const fromName = resolveAgentName(sender);
  const type = msg.type || "message";
  const attrs = [`teammate_id="${fromName}"`, `type="${type}"`];

  if (msg.summary) {
    attrs.push(`summary="${escapeXml(msg.summary)}"`);
  }

  if (msg.requestId) {
    attrs.push(`request_id="${msg.requestId}"`);
  }

  if (msg.approve !== undefined) {
    attrs.push(`approve="${msg.approve}"`);
  }

  if (msg.reason) {
    attrs.push(`reason="${escapeXml(msg.reason)}"`);
  }

  const content = msg.content || "";
  return `<teammate-message ${attrs.join(" ")}>\n${escapeXml(content)}\n</teammate-message>\n`;
}

/**
 * Inject pending messages into agent context
 * Returns XML string for inclusion in system prompt
 */
/**
 * * Inject pending messages into agent context
 * Returns XML string for inclusion in system prompt
 *
 * Note: sessionKey is a property on the SessionEntry type extension used for inbox path
 * but is not part of the core SessionEntry type. It is added to hold session data
 * for teammate session context injection.
 */
export async function injectPendingMessages(
  session: SessionEntry & { sessionKey?: string },
  stateDir: string = process.env.OPENCLAW_STATE_DIR || process.cwd(),
): Promise<string> {
  // Type assertion for session with optional sessionKey extension
  type SessionWithKey = SessionEntry & { sessionKey: string };
  const sessionWithKey = session as SessionWithKey;
  const teamName = sessionWithKey.teamId;
  const sessionKey = sessionWithKey.sessionKey;

  if (!teamName || !sessionKey) {
    return "";
  }

  // Read pending messages
  const messages = await readInboxMessages(teamName, stateDir, sessionKey);

  if (messages.length === 0) {
    return "";
  }

  // Generate XML for each message
  let context = "";
  for (const msg of messages) {
    context += messageToXml(msg as unknown as TeamMessage);
  }

  // Clear processed messages
  await clearInboxMessages(teamName, stateDir, sessionKey);

  return context;
}

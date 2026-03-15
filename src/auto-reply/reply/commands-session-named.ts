import { logVerbose } from "../../globals.js";
import {
  buildNamedDmSessionKey,
  isNamedDmSessionKey,
  parseNamedDmSessionKey,
} from "../../sessions/session-key-utils.js";
import { getActiveNamedSessionKey, setActiveNamedSession } from "../../gateway/session-utils.js";
import { persistSessionEntry } from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";

const RESUME_COMMAND_PREFIX = "/resume";
const DEFAULT_SESSION_NAMES = new Set(["main", "default"]);

/**
 * Handle /resume [name] command for named DM session switching.
 *
 * - /resume → list available named sessions
 * - /resume main|default → return to default session
 * - /resume <name> → switch to named session
 */
export const handleResumeCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const normalized = params.command.commandBodyNormalized;
  if (normalized !== RESUME_COMMAND_PREFIX && !normalized.startsWith(`${RESUME_COMMAND_PREFIX} `)) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /resume from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Only works in DM contexts
  if (params.isGroup) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ /resume only works in direct messages." },
    };
  }

  const args = normalized === RESUME_COMMAND_PREFIX ? "" : normalized.slice(RESUME_COMMAND_PREFIX.length).trim();
  const sessionName = args.toLowerCase();

  // No args → list available named sessions
  if (!sessionName) {
    return listNamedSessions(params);
  }

  // "main" or "default" → clear active named session, return to main
  if (DEFAULT_SESSION_NAMES.has(sessionName)) {
    return clearActiveNamedSession(params);
  }

  // Switch to named session
  return switchToNamedSession(params, sessionName);
};

/**
 * List all named sessions for this DM peer.
 */
async function listNamedSessions(params: Parameters<CommandHandler>[0]): Promise<ReturnType<CommandHandler>> {
  const { sessionStore, sessionEntry, agentId } = params;
  if (!sessionStore) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Session store unavailable." },
    };
  }

  const peerId = params.ctx.SenderId?.trim();
  if (!peerId) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Unable to identify sender for named sessions." },
    };
  }

  const namedSessions: string[] = [];
  for (const key of Object.keys(sessionStore)) {
    const parsed = parseNamedDmSessionKey(key);
    if (parsed && parsed.peerId === peerId.toLowerCase() && parsed.agentId === agentId) {
      namedSessions.push(parsed.name);
    }
  }

  if (namedSessions.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: "ℹ️ No named sessions found. Use `/resume <name>` to create one." },
    };
  }

  const activeSession = sessionEntry?.activeNamedSession;
  const lines = namedSessions.map((name) => {
    const marker = name === activeSession ? "→ " : "  ";
    return `${marker}${name}`;
  });

  return {
    shouldContinue: false,
    reply: {
      text: `📋 Named sessions:\n${lines.join("\n")}\n\nUse \`/resume <name>\` to switch.`,
    },
  };
}

/**
 * Clear the active named session, return to main.
 */
async function clearActiveNamedSession(params: Parameters<CommandHandler>[0]): Promise<ReturnType<CommandHandler>> {
  const { sessionEntry, sessionStore, sessionKey } = params;

  if (!sessionEntry || !sessionStore || !sessionKey) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Session store unavailable." },
    };
  }

  const updated = setActiveNamedSession({
    mainEntry: sessionEntry,
    name: null,
  });

  if (updated) {
    await persistSessionEntry(params);
  }

  return {
    shouldContinue: false,
    reply: { text: "✅ Switched to default session." },
  };
}

/**
 * Switch to (or create) a named session.
 */
async function switchToNamedSession(
  params: Parameters<CommandHandler>[0],
  sessionName: string,
): Promise<ReturnType<CommandHandler>> {
  const { sessionEntry, sessionStore, sessionKey, agentId } = params;

  if (!sessionEntry || !sessionStore || !sessionKey) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Session store unavailable." },
    };
  }

  const peerId = params.ctx.SenderId?.trim();
  if (!peerId) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ Unable to identify sender for named sessions." },
    };
  }

  // Validate session name
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(sessionName)) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Invalid session name. Use letters, numbers, hyphens, or underscores (max 64 chars).",
      },
    };
  }

  // Build the named session key
  let namedSessionKey: string;
  try {
    namedSessionKey = buildNamedDmSessionKey({
      agentId,
      peerId: peerId.toLowerCase(),
      name: sessionName,
    });
  } catch (err) {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Failed to build session key: ${String(err)}` },
    };
  }

  // Check if we're already on this session
  if (sessionEntry.activeNamedSession === sessionName) {
    return {
      shouldContinue: false,
      reply: { text: `ℹ️ Already on session \`${sessionName}\`.` },
    };
  }

  // Check if named session exists
  const namedSessionExists = Boolean(sessionStore[namedSessionKey]);

  // Update main session entry to point to this named session
  const updated = setActiveNamedSession({
    mainEntry: sessionEntry,
    name: sessionName,
  });

  if (updated) {
    await persistSessionEntry(params);
  }

  const action = namedSessionExists ? "Switched to" : "Created and switched to";
  return {
    shouldContinue: false,
    reply: { text: `✅ ${action} session \`${sessionName}\`.` },
  };
}

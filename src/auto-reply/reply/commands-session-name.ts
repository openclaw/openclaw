import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import { updateSessionStoreEntry } from "../../config/sessions/store.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

/**
 * Handles `/name [display-name]` — gets or sets the session display name.
 *
 * - No args → returns current display name or session ID
 * - With args → saves `displayName` on the session entry and confirms
 */
export const handleSessionNameCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized.trim();

  if (!body.startsWith("/name")) {
    return null;
  }

  // Ensure it's exactly "/name" or "/name <args>"
  if (body !== "/name" && !body.startsWith("/name ")) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /name from unauthorized sender: ${params.command.senderId ?? "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const nameArg = body.slice("/name".length).trim();

  if (!nameArg) {
    // Return current display name
    const current =
      params.sessionEntry?.displayName ||
      params.sessionEntry?.label ||
      params.sessionEntry?.sessionId ||
      params.sessionKey;
    return {
      shouldContinue: false,
      reply: { text: `📛 Session name: **${current}**` },
    };
  }

  // Set display name
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const sessionKey = params.sessionKey;

  // Update in store
  await updateSessionStoreEntry({
    storePath,
    sessionKey,
    update: async () => ({ displayName: nameArg }),
  });

  // Also update in-memory session store if present
  if (params.sessionStore && params.sessionEntry) {
    params.sessionStore[sessionKey] = {
      ...params.sessionEntry,
      displayName: nameArg,
      updatedAt: Date.now(),
    };
  }

  logVerbose(`Session named: ${nameArg} for key: ${sessionKey}`);

  return {
    shouldContinue: false,
    reply: { text: `✅ Session named: **${nameArg}**` },
  };
};

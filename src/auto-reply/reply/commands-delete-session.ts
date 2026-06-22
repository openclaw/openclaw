import { resolveMainSessionKey, resolveSessionStoreEntry } from "../../config/sessions.js";
import { callGateway } from "../../gateway/call.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

const DELETE_SESSION_COMMANDS = new Set(["/close", "/delete"]);

export function parseDeleteSessionCommand(raw: string): { command: "/close" | "/delete" } | null {
  const trimmed = raw.trim();
  const commandEnd = trimmed.search(/\s/);
  const commandToken = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  const normalized = commandToken.toLowerCase();
  if (!DELETE_SESSION_COMMANDS.has(normalized)) {
    return null;
  }
  return { command: normalized as "/close" | "/delete" };
}

function deleteSessionReply(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

export const handleDeleteSessionCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseDeleteSessionCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, parsed.command);
  if (unauthorized) {
    return unauthorized;
  }

  if (!params.storePath || !params.sessionKey) {
    return deleteSessionReply("Session deletion is not available for this session.");
  }
  if (params.sessionKey === resolveMainSessionKey(params.cfg) || params.sessionKey === "global") {
    return deleteSessionReply("The main session cannot be deleted from chat. Use /reset instead.");
  }

  const store = params.sessionStore ?? {};
  const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
  const deletion = await callGateway<{ deleted?: boolean }>({
    method: "sessions.delete",
    params: {
      key: resolved.normalizedKey,
      deleteTranscript: true,
    },
  });
  if (!deletion?.deleted) {
    return deleteSessionReply("No active session was found to delete.");
  }

  if (params.sessionStore) {
    delete params.sessionStore[resolved.normalizedKey];
    for (const legacyKey of resolved.legacyKeys) {
      delete params.sessionStore[legacyKey];
    }
  }
  params.sessionEntry = undefined;
  markCommandSessionMetadataChanged(params);
  return deleteSessionReply("✅ Session closed and archived.");
};

import type { SessionEntry } from "../../config/sessions.js";
import { saveSessionStore } from "../../config/sessions.js";
import { setAbortMemory } from "./abort.js";

export async function applySessionHints(params: {
  baseBody: string;
  abortedLastRun: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  abortKey?: string;
  messageId?: string;
}): Promise<string> {
  let prefixedBodyBase = params.baseBody;
  const abortedHint = params.abortedLastRun
    ? "Note: The previous agent run was aborted by the user. Resume carefully or ask for clarification."
    : "";
  if (abortedHint) {
    prefixedBodyBase = `${abortedHint}\n\n${prefixedBodyBase}`;
    if (params.sessionEntry && params.sessionStore && params.sessionKey) {
      params.sessionEntry.abortedLastRun = false;
      params.sessionEntry.updatedAt = Date.now();
      params.sessionStore[params.sessionKey] = params.sessionEntry;
      if (params.storePath) {
        await saveSessionStore(params.storePath, params.sessionStore);
      }
    } else if (params.abortKey) {
      setAbortMemory(params.abortKey, false);
    }
  }

  const messageIdHint = params.messageId?.trim() ? `[message_id: ${params.messageId.trim()}]` : "";
  if (messageIdHint) {
    prefixedBodyBase = `${prefixedBodyBase}\n${messageIdHint}`;
  }

  return prefixedBodyBase;
}

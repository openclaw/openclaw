import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { setAbortMemory } from "./abort.js";

export async function applySessionHints(params: {
  baseBody: string;
  abortedLastRun: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  abortKey?: string;
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
        const sessionKey = params.sessionKey;
        await updateSessionStore(params.storePath, (store) => {
          const entry = store[sessionKey] ?? params.sessionEntry;
          if (!entry) {
            return;
          }
          store[sessionKey] = {
            ...entry,
            abortedLastRun: false,
            updatedAt: Date.now(),
          };
        });
      }
    } else if (params.abortKey) {
      setAbortMemory(params.abortKey, false);
    }
  }

  // Inject a continuity hint when the session was reset by a scheduled policy (daily/idle)
  // and the previous session ended with an assistant message — the agent may have been mid-task.
  const resetHintMsg = params.sessionEntry?.lastAssistantMessageBeforeReset;
  if (resetHintMsg) {
    const resetHint = `Note: This session was automatically reset (daily/idle schedule). The last thing the assistant said before the reset was:\n"${resetHintMsg}"\nIf that suggests unfinished work, you may want to resume it.`;
    prefixedBodyBase = `${resetHint}\n\n${prefixedBodyBase}`;
    if (params.sessionEntry && params.sessionStore && params.sessionKey) {
      params.sessionEntry.lastAssistantMessageBeforeReset = undefined;
      params.sessionEntry.updatedAt = Date.now();
      params.sessionStore[params.sessionKey] = params.sessionEntry;
      if (params.storePath) {
        const sessionKey = params.sessionKey;
        await updateSessionStore(params.storePath, (store) => {
          const entry = store[sessionKey] ?? params.sessionEntry;
          if (!entry) {
            return;
          }
          store[sessionKey] = {
            ...entry,
            lastAssistantMessageBeforeReset: undefined,
            updatedAt: Date.now(),
          };
        });
      }
    }
  }

  return prefixedBodyBase;
}

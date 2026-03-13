import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { setAbortMemory } from "./abort.js";

type SessionHintParams = {
  baseBody: string;
  abortedLastRun: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  abortKey?: string;
};

export function buildSessionHintedBody(
  params: Pick<SessionHintParams, "baseBody" | "abortedLastRun">,
): string {
  let prefixedBodyBase = params.baseBody;
  const abortedHint = params.abortedLastRun
    ? "Note: The previous agent run was aborted by the user. Resume carefully or ask for clarification."
    : "";
  if (abortedHint) {
    prefixedBodyBase = `${abortedHint}\n\n${prefixedBodyBase}`;
  }
  return prefixedBodyBase;
}

export async function commitSessionHintEffects(
  params: Pick<
    SessionHintParams,
    "abortedLastRun" | "sessionEntry" | "sessionStore" | "sessionKey" | "storePath" | "abortKey"
  >,
): Promise<void> {
  if (!params.abortedLastRun) {
    return;
  }
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
    return;
  }
  if (params.abortKey) {
    setAbortMemory(params.abortKey, false);
  }
}

export async function applySessionHints(params: SessionHintParams): Promise<string> {
  const prefixedBodyBase = buildSessionHintedBody(params);
  await commitSessionHintEffects(params);
  return prefixedBodyBase;
}

import type { SessionEntry } from "../../config/sessions/types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { setAbortMemory } from "./abort-primitives.js";

const sessionStoreRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/store.runtime.js"),
);

function loadSessionRowRuntime() {
  return sessionStoreRuntimeLoader.load();
}

export async function applySessionHints(params: {
  baseBody: string;
  abortedLastRun: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
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
      const sessionKey = params.sessionKey;
      const { getSessionEntry, resolveAgentIdFromSessionKey, upsertSessionEntry } =
        await loadSessionRowRuntime();
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const entry = getSessionEntry({ agentId, sessionKey }) ?? params.sessionEntry;
      if (entry) {
        upsertSessionEntry({
          agentId,
          sessionKey,
          entry: {
            ...entry,
            abortedLastRun: false,
            updatedAt: Date.now(),
          },
        });
      }
    } else if (params.abortKey) {
      setAbortMemory(params.abortKey, false);
    }
  }

  return prefixedBodyBase;
}

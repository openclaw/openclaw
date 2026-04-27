import { updateSessionStore } from "../../config/sessions/store.js";
import { applyAbortCutoffToSessionEntry, hasAbortCutoff } from "./abort-cutoff.js";
export async function clearAbortCutoffInSessionRuntime(params) {
    const { sessionEntry, sessionStore, sessionKey, storePath } = params;
    if (!sessionEntry || !sessionStore || !sessionKey || !hasAbortCutoff(sessionEntry)) {
        return false;
    }
    applyAbortCutoffToSessionEntry(sessionEntry, undefined);
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    if (storePath) {
        await updateSessionStore(storePath, (store) => {
            const existing = store[sessionKey] ?? sessionEntry;
            if (!existing) {
                return;
            }
            applyAbortCutoffToSessionEntry(existing, undefined);
            existing.updatedAt = Date.now();
            store[sessionKey] = existing;
        });
    }
    return true;
}

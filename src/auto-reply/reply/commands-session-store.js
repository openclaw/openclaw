import { updateSessionStore } from "../../config/sessions.js";
import { applyAbortCutoffToSessionEntry } from "./abort-cutoff.js";
export async function persistSessionEntry(params) {
    if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
        return false;
    }
    params.sessionEntry.updatedAt = Date.now();
    params.sessionStore[params.sessionKey] = params.sessionEntry;
    if (params.storePath) {
        await updateSessionStore(params.storePath, (store) => {
            store[params.sessionKey] = params.sessionEntry;
        });
    }
    return true;
}
export async function persistAbortTargetEntry(params) {
    const { entry, key, sessionStore, storePath, abortCutoff } = params;
    if (!entry || !key || !sessionStore) {
        return false;
    }
    entry.abortedLastRun = true;
    applyAbortCutoffToSessionEntry(entry, abortCutoff);
    entry.updatedAt = Date.now();
    sessionStore[key] = entry;
    if (storePath) {
        await updateSessionStore(storePath, (store) => {
            const nextEntry = store[key] ?? entry;
            if (!nextEntry) {
                return;
            }
            nextEntry.abortedLastRun = true;
            applyAbortCutoffToSessionEntry(nextEntry, abortCutoff);
            nextEntry.updatedAt = Date.now();
            store[key] = nextEntry;
        });
    }
    return true;
}

import {
  applyKilledSessionEntryState,
  updateSessionStore,
  type SessionEntry,
} from "../../config/sessions.js";
import { applyAbortCutoffToSessionEntry, type AbortCutoff } from "./abort-cutoff.js";
import type { CommandHandler } from "./commands-types.js";

type CommandParams = Parameters<CommandHandler>[0];

export async function persistSessionEntry(params: CommandParams): Promise<boolean> {
  if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
    return false;
  }
  params.sessionEntry.updatedAt = Date.now();
  params.sessionStore[params.sessionKey] = params.sessionEntry;
  if (params.storePath) {
    await updateSessionStore(params.storePath, (store) => {
      store[params.sessionKey] = params.sessionEntry as SessionEntry;
    });
  }
  return true;
}

export async function persistAbortTargetEntry(params: {
  entry?: SessionEntry;
  key?: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  abortCutoff?: AbortCutoff;
  legacyKeys?: string[];
}): Promise<boolean> {
  const { entry, key, sessionStore, storePath, abortCutoff, legacyKeys } = params;
  if (!entry || !key || !sessionStore) {
    return false;
  }

  const nowMs = Date.now();
  applyKilledSessionEntryState(entry, { nowMs, markAbortedLastRun: true });
  applyAbortCutoffToSessionEntry(entry, abortCutoff);
  sessionStore[key] = entry;
  for (const legacyKey of legacyKeys ?? []) {
    if (legacyKey !== key) {
      delete sessionStore[legacyKey];
    }
  }

  if (storePath) {
    await updateSessionStore(storePath, (store) => {
      const nextEntry = store[key] ?? entry;
      if (!nextEntry) {
        return;
      }
      applyKilledSessionEntryState(nextEntry, { nowMs, markAbortedLastRun: true });
      applyAbortCutoffToSessionEntry(nextEntry, abortCutoff);
      store[key] = nextEntry;
      for (const legacyKey of legacyKeys ?? []) {
        if (legacyKey !== key) {
          delete store[legacyKey];
        }
      }
    });
  }

  return true;
}

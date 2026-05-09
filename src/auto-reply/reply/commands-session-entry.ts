import {
  getSessionEntry,
  resolveAgentIdFromSessionKey,
  upsertSessionEntry,
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
  upsertSessionEntry({
    agentId: resolveAgentIdFromSessionKey(params.sessionKey),
    sessionKey: params.sessionKey,
    entry: params.sessionEntry,
  });
  return true;
}

export async function persistAbortTargetEntry(params: {
  entry?: SessionEntry;
  key?: string;
  sessionStore?: Record<string, SessionEntry>;
  abortCutoff?: AbortCutoff;
}): Promise<boolean> {
  const { entry, key, sessionStore, abortCutoff } = params;
  if (!entry || !key || !sessionStore) {
    return false;
  }

  entry.abortedLastRun = true;
  applyAbortCutoffToSessionEntry(entry, abortCutoff);
  entry.updatedAt = Date.now();
  sessionStore[key] = entry;

  const agentId = resolveAgentIdFromSessionKey(key);
  const nextEntry = getSessionEntry({ agentId, sessionKey: key }) ?? entry;
  nextEntry.abortedLastRun = true;
  applyAbortCutoffToSessionEntry(nextEntry, abortCutoff);
  nextEntry.updatedAt = Date.now();
  upsertSessionEntry({
    agentId,
    sessionKey: key,
    entry: nextEntry,
  });

  return true;
}

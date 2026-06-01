// Shared session-store helpers for command handlers that mutate sessions.
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import type { SessionMetadataChangedEvent } from "../get-reply-options.types.js";
import { applyAbortCutoffToSessionEntry, type AbortCutoff } from "./abort-cutoff.js";
import type { CommandHandler } from "./commands-types.js";

type CommandParams = Parameters<CommandHandler>[0];
type SessionMetadataChangedCallback = (event: SessionMetadataChangedEvent) => Promise<void> | void;

function resolveSessionMetadataAgentId(
  sessionKey: string,
  agentId?: string,
): string | undefined {
  if (sessionKey === "global") {
    return agentId ? normalizeAgentId(agentId) : undefined;
  }
  return parseAgentSessionKey(sessionKey)?.agentId;
}

function createSessionMetadataChangedEvent(params: {
  sessionKey: string;
  agentId?: string;
}): SessionMetadataChangedEvent {
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (parsed?.rest === "global") {
    return {
      sessionKey: "global",
      agentId: normalizeAgentId(parsed.agentId),
      reason: "command-metadata",
    };
  }
  const agentId = resolveSessionMetadataAgentId(params.sessionKey, params.agentId);
  return {
    sessionKey: params.sessionKey,
    ...(agentId ? { agentId } : {}),
    reason: "command-metadata",
  };
}

export async function dispatchSessionMetadataChanged(
  event: SessionMetadataChangedEvent,
  onSessionMetadataChanged?: SessionMetadataChangedCallback,
): Promise<void> {
  const normalizedEvent = createSessionMetadataChangedEvent(event);
  if (onSessionMetadataChanged) {
    await onSessionMetadataChanged(normalizedEvent);
    return;
  }
  emitSessionLifecycleEvent(normalizedEvent);
}

export async function notifySessionMetadataChanged(params: CommandParams): Promise<void> {
  if (!params.sessionKey) {
    return;
  }
  await dispatchSessionMetadataChanged(
    createSessionMetadataChangedEvent({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    }),
    params.opts?.onSessionMetadataChanged,
  );
}

export async function persistSessionEntry(params: CommandParams): Promise<boolean> {
  if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
    return false;
  }
  params.sessionEntry.updatedAt = Date.now();
  params.sessionStore[params.sessionKey] = params.sessionEntry;
  if (params.storePath) {
    // Slash commands mutate one known session entry; skipping global session
    // maintenance avoids scanning the whole sessions directory for simple
    // command-only writes.
    await updateSessionStore(
      params.storePath,
      (store) => {
        store[params.sessionKey] = params.sessionEntry as SessionEntry;
        return params.sessionEntry as SessionEntry;
      },
      {
        resolveSingleEntryPersistence: (entry) =>
          entry ? { sessionKey: params.sessionKey, entry } : null,
        skipMaintenance: true,
      },
    );
  }
  await notifySessionMetadataChanged(params);
  return true;
}

export async function persistAbortTargetEntry(params: {
  entry?: SessionEntry;
  key?: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  abortCutoff?: AbortCutoff;
  agentId?: string;
  onSessionMetadataChanged?: SessionMetadataChangedCallback;
}): Promise<boolean> {
  const { entry, key, sessionStore, storePath, abortCutoff } = params;
  if (!entry || !key || !sessionStore) {
    return false;
  }

  entry.abortedLastRun = true;
  applyAbortCutoffToSessionEntry(entry, abortCutoff);
  entry.updatedAt = Date.now();
  sessionStore[key] = entry;

  if (storePath) {
    await updateSessionStore(
      storePath,
      (store) => {
        const nextEntry = store[key] ?? entry;
        if (!nextEntry) {
          return undefined;
        }
        nextEntry.abortedLastRun = true;
        applyAbortCutoffToSessionEntry(nextEntry, abortCutoff);
        nextEntry.updatedAt = Date.now();
        store[key] = nextEntry;
        return nextEntry;
      },
      {
        resolveSingleEntryPersistence: (updated) =>
          updated ? { sessionKey: key, entry: updated } : null,
      },
    );
  }

  await dispatchSessionMetadataChanged(
    createSessionMetadataChangedEvent({
      sessionKey: key,
      agentId: params.agentId,
    }),
    params.onSessionMetadataChanged,
  );
  return true;
}

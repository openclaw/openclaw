import {
  createSessionProjection,
  type SessionProjectionEntry,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";
import { nativeHistoryMessageSourceIdentity } from "../../lib/chat/history-message-identity.ts";
import {
  readPairingQrContent,
  removePairingQrContent,
  retainPairingQrEntries,
} from "../../lib/chat/pairing-qr.ts";
import { chatProjectionScopeChanged } from "./chat-projection-scope.ts";

export function projectionMessageEntries(
  current: SessionProjectionState,
  messages: readonly unknown[],
): readonly SessionProjectionEntry[] {
  const occurrences = new Map<unknown, SessionProjectionEntry[]>();
  for (const entry of current.entries.toReversed()) {
    const queue = occurrences.get(entry.message);
    if (queue) {
      queue.push(entry);
    } else {
      occurrences.set(entry.message, [entry]);
    }
  }
  return createSessionProjection(current.scope, messages).entries.map(
    (entry) => occurrences.get(entry.message)?.pop() ?? entry,
  );
}

export function retainsPairingQrScope(
  previous: SessionProjectionScope,
  next: SessionProjectionScope,
) {
  return !chatProjectionScopeChanged(previous, next, [
    "sessionKey",
    "sessionId",
    "agentId",
    "lifecycleRevision",
  ]);
}

/** Report enriched native bodies so callers revoke their original packet certificate. */
export function enrichChatProjectionEntries(
  previous: readonly SessionProjectionEntry[],
  incoming: readonly SessionProjectionEntry[],
) {
  const entries = retainPairingQrEntries(previous, incoming);
  if (entries === incoming) {
    return undefined;
  }
  const changedSources = new Set<string>();
  const messages = entries.map((entry, index) => {
    if (entry.message !== incoming[index]?.message) {
      const source = nativeHistoryMessageSourceIdentity(entry.message);
      if (source) {
        changedSources.add(source);
      }
    }
    return entry.message;
  });
  return { entries, messages, changedSources };
}

/** Preserve admitted pairing media before tentative cost and wire-certificate checks. */
export function prepareChatProjectionMessages(
  current: SessionProjectionState,
  messages: readonly unknown[],
  scope: SessionProjectionScope,
) {
  if (
    retainsPairingQrScope(current.scope, scope) &&
    current.entries.some((entry) => readPairingQrContent(entry.message).length)
  ) {
    const entries = projectionMessageEntries(current, messages);
    const enriched = enrichChatProjectionEntries(current.entries, entries);
    return {
      messages: enriched?.messages ?? entries.map((entry) => entry.message),
      changedSources: enriched?.changedSources ?? new Set<string>(),
    };
  }
  return { messages, changedSources: new Set<string>() };
}

/** Retire media from displayed entries and retained run receipts together. */
export function retireChatProjectionPairingQr(projection: SessionProjectionState) {
  const retireEntry = (entry: SessionProjectionEntry): SessionProjectionEntry => {
    const message = removePairingQrContent(entry.message);
    return message === entry.message ? entry : { ...entry, message };
  };
  const entries = projection.entries.map(retireEntry);
  const runs = Object.fromEntries(
    Object.entries(projection.runs).map(([runId, run]) => {
      const message = removePairingQrContent(run.message);
      const terminal = run.inferredSnapshotTerminal;
      const entry = terminal ? retireEntry(terminal.entry) : undefined;
      return [
        runId,
        message === run.message && entry === terminal?.entry
          ? run
          : {
              ...run,
              message,
              ...(terminal && entry ? { inferredSnapshotTerminal: { ...terminal, entry } } : {}),
            },
      ];
    }),
  );
  return { ...projection, entries, messages: entries.map((entry) => entry.message), runs };
}

import {
  readSessionMessageSequence,
  type SessionProjectionEntry,
} from "@openclaw/gateway-client/browser";
import {
  nativeHistoryMessageIdentity,
  nativeHistoryMessageSourceIdentity,
} from "./history-message-identity.ts";

/** Preserve projected siblings while removing only overlapping page occurrences. */
export function prependUniqueNativeMessages(
  messages: readonly unknown[],
  current: readonly unknown[],
  localEntries: readonly SessionProjectionEntry[] = [],
) {
  const incomingSources = new Set<string>();
  for (const message of messages) {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (source) {
      incomingSources.add(source);
    }
  }
  const overlappingSources = new Map<string, number>();
  const duplicateCounts = new Map<string, { count: number; source: string }>();
  for (const [index, message] of current.entries()) {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (!source || !incomingSources.has(source)) {
      continue;
    }
    // Most older pages have disjoint sources. Only overlapping rows need
    // content comparison; keep counts local so hydrated projections stay fresh.
    const identity = nativeHistoryMessageIdentity(message);
    if (identity) {
      overlappingSources.set(source, index + 1);
      const duplicate = duplicateCounts.get(identity);
      duplicateCounts.set(identity, { count: (duplicate?.count ?? 0) + 1, source });
    }
  }
  const insertions = new Map<number, unknown[]>();
  const incomingExpandedSources = new Set<string>();
  const currentExpandedSources = new Set<string>();
  let after = 0;
  for (const message of messages) {
    const source = nativeHistoryMessageSourceIdentity(message);
    const overlap = source ? overlappingSources.get(source) : undefined;
    const identity = overlap !== undefined ? nativeHistoryMessageIdentity(message) : null;
    const duplicate = identity ? duplicateCounts.get(identity) : undefined;
    if (overlap !== undefined && duplicate && duplicate.count > 0) {
      duplicate.count -= 1;
      after = Math.max(after, overlap);
      continue;
    }
    if (overlap !== undefined && source) {
      currentExpandedSources.add(source);
    }
    // Live receipts may already occupy an interior source of this server page.
    // Insert disjoint sources after that observed group, keeping current objects
    // and the existing extra-occurrence policy for overlapping projections.
    const position = overlap === undefined ? after : 0;
    const queued = insertions.get(position) ?? [];
    queued.push(message);
    insertions.set(position, queued);
  }
  // Carry occurrence facts into page admission: source names alone cannot
  // certify a wire packet after either input contributes additional siblings.
  for (const { count, source } of duplicateCounts.values()) {
    if (count > 0) {
      incomingExpandedSources.add(source);
    }
  }
  const merged: unknown[] = [];
  for (let index = 0; index <= current.length; index += 1) {
    for (const message of insertions.get(index) ?? []) {
      merged.push(message);
    }
    if (index < current.length) {
      merged.push(current[index]);
    }
  }
  if (localEntries.length) {
    // Only recorded local occurrences move earlier across a newly filled gap.
    // Keep already-correct placement among unsequenced live/pending rows; the
    // predecessor may be retired, but its cut survives in the entry.
    const cuts = new Map<unknown, SessionProjectionEntry[]>();
    for (const entry of localEntries) {
      if (entry.localOutput && (entry.atHistoryStart || entry.afterSequence != null)) {
        const queue = cuts.get(entry.message) ?? [];
        queue.push(entry);
        cuts.set(entry.message, queue);
      }
    }
    // Start-placed outputs keep their insertion order before newly admitted sources.
    let startOutputs = 0;
    for (let index = 0; index < merged.length; index += 1) {
      const message = merged[index];
      const entry = cuts.get(message)?.shift();
      if (!entry) {
        continue;
      }
      const cut = entry.afterSequence;
      const boundary = entry.atHistoryStart
        ? startOutputs++
        : cut == null
          ? -1
          : merged.findIndex((candidate) => (readSessionMessageSequence(candidate) ?? -1) > cut);
      if (boundary >= 0 && boundary < index) {
        merged.splice(index, 1);
        merged.splice(boundary, 0, message);
      }
    }
  }
  return { messages: merged, incomingExpandedSources, currentExpandedSources };
}

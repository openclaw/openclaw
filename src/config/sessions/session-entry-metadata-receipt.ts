import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteCommitReceipt,
  hasSqliteCommitReceiptCoverage,
  type SqliteCommitReceipt,
} from "../../infra/sqlite-commit-receipt.js";
import type { SessionRowChange, SessionRowFacts } from "../../sessions/session-row-changes.js";
import { preparedSharingChanges } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionEntryPublicationSource } from "./session-accessor.sqlite-entry-cache.types.js";
import {
  hasSessionEntryPublicationCapacity,
  sealSessionEntryPublicationSource,
} from "./session-entry-publication-source.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionEntryMetadataFact = {
  entry: SessionEntry;
  fullEntry?: SessionEntry;
  previous?: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  facts: Extract<SessionRowFacts, { kind: "entry" }>;
  sharingChange: "changed" | "unchanged";
};
export type SessionEntryMetadataReceipt = SqliteCommitReceipt<
  SessionEntryMetadataFact,
  SessionEntryPublicationSource
>;

/** Reuse the native entry owner's already selected postimage and exact delta semantics. */
export function captureSessionEntryMetadataReceipts(changes: readonly SessionRowChange[]) {
  const latest = new Map<
    string,
    { source: SessionEntryPublicationSource; value: SessionEntryMetadataFact }
  >();
  for (const change of changes) {
    if (!("sessionKey" in change) || change.facts?.kind !== "entry") {
      continue;
    }
    const publication = preparedSharingChanges.changes.get(change);
    const entry =
      publication?.kind === "metadata"
        ? publication.prepared.entries.get(change.sessionKey)
        : undefined;
    if (
      !entry ||
      publication?.kind !== "metadata" ||
      typeof publication.prepared.source.identity !== "string"
    ) {
      continue;
    }
    const previous = latest.get(change.sessionKey);
    latest.set(change.sessionKey, {
      source: publication.prepared.source,
      value: {
        entry,
        fullEntry: publication.prepared.fullEntries?.get(change.sessionKey),
        previous: previous ? previous.value.previous : publication.previous,
        sharingChange:
          previous?.value.sharingChange === "changed" ? "changed" : publication.sharingChange,
        facts: {
          ...change.facts,
          lifecycleChanged: previous?.value.facts.lifecycleChanged || change.facts.lifecycleChanged,
          previousSessionId: previous
            ? previous.value.facts.previousSessionId
            : change.facts.previousSessionId,
          clearMembers: previous?.value.facts.clearMembers || change.facts.clearMembers,
        },
      },
    });
  }
  const receipts = [...latest].map(([key, { source, value }]) => {
    sealSessionEntryPublicationSource(source);
    return createSqliteCommitReceipt({
      source,
      domain: "session-entry-metadata",
      keys: [key],
      readFact: () => ({ kind: "postimage", value }),
    });
  });
  boundSessionEntryMetadataReceipts(receipts);
  return receipts;
}

/** Metadata shares an envelope with transcript authority; only full-entry enrichment may be shed. */
export function boundSessionEntryMetadataReceipts(
  receipts: readonly SessionEntryMetadataReceipt[],
  envelope: unknown = receipts,
): void {
  const enriched = receipts.some((receipt) =>
    [...receipt.facts.values()].some(
      (fact) => fact.kind === "postimage" && fact.value.fullEntry !== undefined,
    ),
  );
  if (!enriched || hasSessionEntryPublicationCapacity(envelope)) {
    return;
  }
  for (const receipt of receipts) {
    delete receipt.source.writeToken;
    for (const fact of receipt.facts.values()) {
      if (fact.kind === "postimage") {
        delete fact.value.fullEntry;
      }
    }
  }
}

export function parseSessionEntryMetadataReceipts(
  value: unknown,
): readonly SessionEntryMetadataReceipt[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const receipt of value) {
    if (
      !isRecord(receipt) ||
      !isRecord(receipt.source) ||
      typeof receipt.source.identity !== "string" ||
      typeof receipt.source.incarnation !== "string" ||
      !(receipt.facts instanceof Map)
    ) {
      return undefined;
    }
    const keys = [...receipt.facts.keys()];
    if (
      !keys.every((key) => typeof key === "string") ||
      !hasSqliteCommitReceiptCoverage(receipt, {
        source: { identity: receipt.source.identity, incarnation: receipt.source.incarnation },
        domain: "session-entry-metadata",
        keys,
      })
    ) {
      return undefined;
    }
    for (const [, fact] of receipt.facts) {
      if (!isRecord(fact) || fact.kind !== "postimage" || !isRecord(fact.value)) {
        return undefined;
      }
      const row = fact.value;
      if (
        (row.previous !== undefined &&
          (!isRecord(row.previous) ||
            typeof row.previous.sessionId !== "string" ||
            (row.previous.lifecycleRevision !== undefined &&
              typeof row.previous.lifecycleRevision !== "string"))) ||
        !isRecord(row.entry) ||
        typeof row.entry.sessionId !== "string" ||
        typeof row.entry.updatedAt !== "number" ||
        (row.fullEntry !== undefined &&
          (!isRecord(row.fullEntry) ||
            row.fullEntry.sessionId !== row.entry.sessionId ||
            row.fullEntry.updatedAt !== row.entry.updatedAt)) ||
        !isRecord(row.facts) ||
        row.facts.kind !== "entry" ||
        row.facts.sessionId !== row.entry.sessionId ||
        (row.facts.previousSessionId !== undefined &&
          typeof row.facts.previousSessionId !== "string") ||
        typeof row.facts.clearMembers !== "boolean" ||
        (row.facts.lifecycleChanged !== undefined &&
          typeof row.facts.lifecycleChanged !== "boolean") ||
        (row.sharingChange !== "changed" && row.sharingChange !== "unchanged")
      ) {
        return undefined;
      }
    }
  }
  // SAFETY: The paired native writer owns the remaining entry schema; native receipt equality seals it.
  return value as readonly SessionEntryMetadataReceipt[];
}

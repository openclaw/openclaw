import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptMessageAppendResult } from "./session-accessor.sqlite-contract.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { SessionEntry } from "./types.js";

/** Owner-issued facts remain private; a copied public tuple cannot issue them. */
export type TranscriptEntryProvenance = Readonly<{
  canonicalSource:
    | Readonly<{
        sessionId: string;
        lifecycleRevision: string | undefined;
      }>
    | undefined;
  database: Readonly<{ path: string; identity: DatabaseFileIdentity }> | undefined;
}>;

type TranscriptEntryOrigin = Readonly<
  Pick<TranscriptEntryAnchor, "agentId" | "sessionKey" | "sessionId" | "entryId">
>;
type RetainedTranscriptEntryProvenance = Readonly<{
  provenance: TranscriptEntryProvenance;
  origin: TranscriptEntryOrigin;
}>;

// SDK/core bundles share the same owner-issued facts; worker replies still require explicit rebinding.
const entryProvenance = resolveGlobalSingleton(
  Symbol.for("openclaw.transcriptEntryProvenance"),
  () => new WeakMap<object, RetainedTranscriptEntryProvenance>(),
);

function assertTranscriptEntryOrigin(
  anchor: TranscriptEntryAnchor,
  origin: TranscriptEntryOrigin,
): void {
  if (
    anchor.agentId !== origin.agentId ||
    anchor.sessionKey !== origin.sessionKey ||
    anchor.sessionId !== origin.sessionId ||
    anchor.entryId !== origin.entryId
  ) {
    throw new Error("Transcript provenance cannot be rebound to another source tuple.");
  }
}

export function createTranscriptEntryProvenance(
  entry: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined,
  database: TranscriptEntryProvenance["database"],
): TranscriptEntryProvenance {
  return Object.freeze({
    canonicalSource: entry
      ? Object.freeze({ sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision })
      : undefined,
    database: database
      ? Object.freeze({ path: database.path, identity: Object.freeze({ ...database.identity }) })
      : undefined,
  });
}

/** Use the native owner's registered identity, never a later pathname observation. */
export function captureTranscriptEntryProvenance(
  database: OpenClawAgentDatabase,
  entry: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined,
): TranscriptEntryProvenance {
  const owner = readOpenClawAgentDatabaseIdentity(database);
  return createTranscriptEntryProvenance(
    entry,
    typeof owner.identity === "string"
      ? {
          path: database.path,
          identity: { key: `file:${owner.identity}`, birthtime: owner.birthtime },
        }
      : undefined,
  );
}

/** Called only for results retained by the acknowledged transaction owner. */
export function rememberTranscriptMessageProvenance(
  messages: readonly TranscriptMessageAppendResult<unknown>[],
  provenance: TranscriptEntryProvenance,
  source: Pick<TranscriptEntryAnchor, "agentId" | "sessionKey" | "sessionId">,
): void {
  for (const message of messages) {
    if (!message.appended || !isRecord(message.message) || message.message.role !== "user") {
      continue;
    }
    const retained = Object.freeze({
      provenance,
      origin: Object.freeze({
        agentId: source.agentId,
        sessionKey: source.sessionKey,
        sessionId: source.sessionId,
        entryId: message.messageId,
      }),
    });
    entryProvenance.set(message, retained);
    if (message.anchor) {
      assertTranscriptEntryOrigin(message.anchor, retained.origin);
      entryProvenance.set(message.anchor, retained);
    }
  }
}

/** Deferred projection retains the original write facts across its later read. */
export function copyTranscriptMessageProvenanceToAnchor(
  message: TranscriptMessageAppendResult<unknown>,
  anchor: TranscriptEntryAnchor,
): void {
  const retained = entryProvenance.get(message);
  if (!retained) {
    return;
  }
  if (message.messageId !== anchor.entryId) {
    throw new Error("Transcript provenance cannot be rebound to another input.");
  }
  assertTranscriptEntryOrigin(anchor, retained.origin);
  entryProvenance.set(anchor, retained);
}

/** Only an explicit core derivation may carry the same input's original facts. */
export function copyTranscriptEntryProvenance(
  source: TranscriptEntryAnchor,
  derived: TranscriptEntryAnchor,
): void {
  const retained = entryProvenance.get(source);
  if (!retained) {
    return;
  }
  assertTranscriptEntryOrigin(source, retained.origin);
  assertTranscriptEntryOrigin(derived, retained.origin);
  entryProvenance.set(derived, retained);
}

/** Undefined means unattested; canonicalSource undefined means an attested rowless original. */
export function readTranscriptEntryProvenance(
  anchor: TranscriptEntryAnchor,
): TranscriptEntryProvenance | undefined {
  const retained = entryProvenance.get(anchor);
  if (!retained) {
    return undefined;
  }
  assertTranscriptEntryOrigin(anchor, retained.origin);
  return retained.provenance;
}

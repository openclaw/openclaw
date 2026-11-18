import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  transcriptWriteScopeIsCurrent,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

export function assertNonMessageTranscriptEvent(event: TranscriptEvent): void {
  // Message records require parent-link, idempotency, and redaction handling
  // from appendTranscriptMessage; raw event writes would bypass those invariants.
  if (isRecord(event) && "type" in event && event.type === "message") {
    throw new Error(
      "appendTranscriptEvent cannot write message transcript records; use appendTranscriptMessage instead.",
    );
  }
}

export function resolveTranscriptAppendRefusal(
  entry: InternalSessionEntry | undefined,
  resolved: ResolvedTranscriptScope,
  scope: SessionTranscriptWriteScope,
): TranscriptAppendRefusal | undefined {
  if (transcriptWriteScopeIsCurrent(entry, resolved.sessionId, scope)) {
    return undefined;
  }
  const identity = {
    agentIdHash: redactIdentifier(resolved.agentId),
    expectedSessionIdHash: redactIdentifier(resolved.sessionId),
    sessionKeyHash: redactIdentifier(resolved.sessionKey),
  };
  if (!entry) {
    return { ...identity, code: "session-entry-missing" };
  }
  return {
    ...identity,
    actualSessionIdHash: redactIdentifier(entry.sessionId),
    code: "session-rebound",
  };
}

export function assertLockedTranscriptWriteAllowed(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  scope: SessionTranscriptWriteScope,
): InternalSessionEntry | undefined {
  assertSessionTranscriptHot(database.db, resolved.sessionId);
  const fencedScope = {
    ...scope,
    sessionId: resolved.sessionId,
    sessionKey: resolved.sessionKey,
  };
  assertOwnedTranscriptWriteCommit(fencedScope);
  if (
    fencedScope.expectedLifecycleRevision === undefined &&
    fencedScope.expectedWriterRunId === undefined &&
    fencedScope.expectedOwner === undefined
  ) {
    return undefined;
  }
  const fresh = readSessionEntryRow(database, resolved.sessionKey);
  const refusal = resolveTranscriptAppendRefusal(fresh?.entry, resolved, fencedScope);
  if (refusal) {
    throw new SessionTranscriptWriterClaimReboundError(refusal);
  }
  return fresh?.entry;
}

import type { SessionTranscriptAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  publishIncognitoSessionEntry,
  type IncognitoSessionBinding,
} from "./session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import {
  acceptSessionSourceValidation,
  type PreparedSessionSourceAuthority,
} from "./session-source-authority.js";
import type { RefusedTranscriptOwnerSource } from "./session-transcript-mutation.types.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import type { SessionEntry } from "./types.js";

/** Detached selection stays with the captured actor through its acknowledged CAS commit. */
export function trimIncognitoTranscript(
  binding: IncognitoSessionBinding & { authority: IncognitoSessionAuthority },
  scope: SessionTranscriptAccessScope,
  selectRetainedLines: (lines: readonly string[]) => readonly string[] | null,
  options: {
    nowMs?: number;
    preparation?: {
      source?: PreparedSessionSourceAuthority;
      assertEntryCurrent(entry: SessionEntry | undefined): void;
      assertCurrent(): void;
      assertCommitCurrent(): void;
    };
  },
): Promise<{ trimmed: false } | { kept: number; trimmed: true }> {
  const { actor, admissionSignal } = binding;
  const resolved = resolveSqliteTranscriptScope({
    ...scope,
    agentId: actor.agentId,
    storePath: actor.path,
  });
  const target = { sessionKey: resolved.sessionKey, sessionId: resolved.sessionId, fence: {} };
  const authority = {
    assertCurrent() {
      binding.authority.assertCurrent();
      options.preparation?.assertCurrent();
    },
    authorize() {
      options.preparation?.assertCommitCurrent();
    },
  };
  const refuse = ({ refusedOwnerSource }: RefusedTranscriptOwnerSource): never => {
    options.preparation?.source?.checks[refusedOwnerSource.index]?.refuse(refusedOwnerSource.facts);
    throw new Error("Manual compaction source refusal omitted its authority assertion");
  };
  return actor.sessions.withSharedState(async () => {
    const prepared = await actor.sessions.transcript(
      authority,
      {
        type: "session.manualCompact.prepare",
        input: {
          ...target,
          sources: options.preparation?.source?.checks.map(({ predicate }) => predicate) ?? [],
        },
      },
      admissionSignal,
    );
    if ("refusedOwnerSource" in prepared) {
      return refuse(prepared);
    }
    if (options.preparation?.source) {
      acceptSessionSourceValidation(options.preparation.source, prepared.sourceValidation);
    }
    authority.assertCurrent();
    options.preparation?.assertEntryCurrent(prepared.sessionSnapshot[0]?.entry);
    const retainedLines = selectRetainedLines(prepared.rows.map((row) => row.eventJson));
    if (!retainedLines) {
      return { trimmed: false as const };
    }
    admissionSignal?.throwIfAborted();
    const result = await actor.sessions.transcript(
      authority,
      {
        type: "session.manualCompact.commit",
        input: {
          ...target,
          prepared,
          retainedEvents: retainedLines.map((line) => JSON.parse(line)),
          nowMs: options.nowMs,
          sources: options.preparation?.source?.checks.map(({ predicate }) => predicate) ?? [],
        },
      },
      undefined,
      undefined,
      (committed) => {
        if ("refusedOwnerSource" in committed) {
          return;
        }
        const { previous, current } = committed;
        publishIncognitoSessionEntry(
          actor,
          target.sessionKey,
          previous.get(target.sessionKey),
          current.get(target.sessionKey),
        );
      },
      undefined,
      (_refused, validation) => {
        if (options.preparation?.source) {
          acceptSessionSourceValidation(options.preparation.source, validation);
        }
        authority.assertCurrent();
        authority.authorize();
      },
    );
    if ("refusedOwnerSource" in result) {
      return refuse(result);
    }
    if (result.projectionNeedsReconcile) {
      startSessionTranscriptIndexReconcile({
        agentId: actor.agentId,
        path: actor.path,
        preferredSessionId: target.sessionId,
      });
    }
    return { kept: retainedLines.length, trimmed: true as const };
  });
}

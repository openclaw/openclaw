import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionTranscriptDisplayDeltaResult } from "../config/sessions/session-accessor.sqlite-history-query.js";
import type {
  SessionHistoryDelta,
  SessionHistorySubagentFacts,
  SessionHistorySubagentLookup,
} from "../config/sessions/session-history-types.js";
import {
  encodeSessionTranscriptWorkerError,
  SessionHistoryDeltaPreparationError,
  unwrapSessionTranscriptWorkerReply,
} from "../config/sessions/session-history-worker-errors.js";
import { createChatHistoryRecoveryProjection } from "./chat-display-projection.core.js";
import {
  createSubagentCoordinationHistoryProjection,
  type SubagentCoordinationDisplayResolver,
} from "./chat-display-projection.history.js";
import { projectTranscriptEntryMessage } from "./session-transcript-entry-message.js";

export function isAppendOnlySessionHistoryDelta(
  delta: SessionTranscriptDisplayDeltaResult,
): delta is Extract<SessionTranscriptDisplayDeltaResult, { kind: "page" }> {
  return (
    delta.kind === "page" &&
    !delta.hasMore &&
    !delta.events.some(({ event }) => {
      const type = asOptionalRecord(event)?.type;
      // Leaf appends can remove cached rows without changing the raw generation.
      return type === "reset" || type === "compaction" || type === "leaf";
    })
  );
}

/** Inline projection asks at most one source or run question, without transferring message bodies. */
export function readSessionHistorySubagentLookup(
  message: unknown,
): SessionHistorySubagentLookup | undefined {
  let lookup: SessionHistorySubagentLookup | undefined;
  createSubagentCoordinationHistoryProjection({
    isSubagentSession: (sessionKey) => {
      lookup = { kind: "session", sessionKey };
      return false;
    },
    isSubagentRunMessage: (runId, messageSeq) => {
      lookup = { kind: "run", runId, messageSeq };
      return false;
    },
  })([message]);
  return lookup;
}

export function prepareSessionHistorySubagentFacts(
  resolver: SubagentCoordinationDisplayResolver,
  project: (recording: SubagentCoordinationDisplayResolver) => void,
  onFailure?: (facts: SessionHistorySubagentFacts, error: unknown) => never,
): SessionHistorySubagentFacts {
  const sessions = new Map<string, boolean>();
  const runMessages: SessionHistorySubagentFacts["runMessages"] = [];
  const readFact = (lookup: SessionHistorySubagentLookup, read: () => boolean): boolean => {
    try {
      return read();
    } catch (error) {
      const encoded = encodeSessionTranscriptWorkerError(error);
      if (!encoded || !onFailure) {
        throw error;
      }
      return onFailure(
        {
          sessions: [...sessions],
          runMessages,
          failure: { lookup, error: encoded },
        },
        error,
      );
    }
  };
  const recording: SubagentCoordinationDisplayResolver = {
    assertCurrent: resolver.assertCurrent,
    isSubagentSession(sessionKey) {
      const hidden = readFact({ kind: "session", sessionKey }, () =>
        resolver.isSubagentSession(sessionKey),
      );
      sessions.set(sessionKey, hidden);
      return hidden;
    },
    isSubagentRunMessage(runId, messageSeq) {
      const hidden = readFact({ kind: "run", runId, messageSeq }, () =>
        resolver.isSubagentRunMessage(runId, messageSeq),
      );
      runMessages.push([runId, messageSeq, hidden]);
      return hidden;
    },
  };
  project(recording);
  return { sessions: [...sessions], runMessages };
}

/** Prepare only the visibility decisions requested by this bounded delta's messages. */
export function prepareSessionHistoryDelta(
  delta: SessionTranscriptDisplayDeltaResult,
  resolver: SubagentCoordinationDisplayResolver,
): SessionHistoryDelta {
  const subagentCoordination = prepareSessionHistorySubagentFacts(
    resolver,
    (recording) => {
      if (!isAppendOnlySessionHistoryDelta(delta)) {
        return;
      }
      for (const row of delta.events) {
        if (row.messageSeq === undefined) {
          continue;
        }
        const message = projectTranscriptEntryMessage(
          row.event,
          row.messageSeq,
          row.displayPosition,
        );
        if (message) {
          // Recovery normalizes custom failures and nested-tool run IDs before visibility.
          createChatHistoryRecoveryProjection({ subagentCoordination: recording }).append([
            message,
          ]);
        }
      }
    },
    (facts, error) => {
      // Join reader retirement before the host consumes partial facts or an earlier reset.
      throw new SessionHistoryDeltaPreparationError({ delta, subagentCoordination: facts }, error);
    },
  );
  return { delta, subagentCoordination };
}

export function createPreparedSessionHistorySubagentProjection(
  facts: SessionHistorySubagentFacts,
  assertCurrent: () => void,
): SubagentCoordinationDisplayResolver {
  const sessions = new Map(facts.sessions);
  const runs = new Map<string, Map<number | undefined, boolean>>();
  for (const [runId, messageSeq, hidden] of facts.runMessages) {
    let messages = runs.get(runId);
    if (!messages) {
      messages = new Map();
      runs.set(runId, messages);
    }
    messages.set(messageSeq, hidden);
  }
  const requireFact = (
    hidden: boolean | undefined,
    lookup: SessionHistorySubagentLookup,
  ): boolean => {
    assertCurrent();
    if (hidden === undefined) {
      const failed = facts.failure?.lookup;
      if (
        facts.failure &&
        ((lookup.kind === "session" &&
          failed?.kind === "session" &&
          lookup.sessionKey === failed.sessionKey) ||
          (lookup.kind === "run" &&
            failed?.kind === "run" &&
            lookup.runId === failed.runId &&
            lookup.messageSeq === failed.messageSeq))
      ) {
        unwrapSessionTranscriptWorkerReply({ ok: false, error: facts.failure.error });
      }
      throw new Error("Session history visibility is unavailable; retry the request.");
    }
    return hidden;
  };
  return {
    assertCurrent,
    isSubagentSession: (sessionKey) =>
      requireFact(sessions.get(sessionKey), { kind: "session", sessionKey }),
    isSubagentRunMessage: (runId, messageSeq) =>
      requireFact(runs.get(runId)?.get(messageSeq), { kind: "run", runId, messageSeq }),
  };
}

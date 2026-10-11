import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isSubagentSessionFromEntry } from "../agents/subagents/spawn/subagent-depth-policy.js";
import type { SessionActorMemoryHistoryReads } from "../config/sessions/session-actor-memory-history-contract.js";
import type { captureSessionActorTranscriptRead } from "../config/sessions/session-actor-transcript-read.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-transcript.metadata.js";
import { createChatHistoryRecoveryProjection } from "./chat-display-projection.core.js";
import { isSubagentCoordinationHistoryInput } from "./chat-display-projection.history.js";
import { prepareSessionHistorySubagentFacts } from "./session-history-delta-visibility.js";
import { filterSessionMessageHistoryVisibility } from "./session-transcript-read-kernel.js";
import type {
  SessionTranscriptReader,
  SessionTranscriptVisitor,
  SubagentCoordinationDisplayResolver,
} from "./session-transcript-read.types.js";

type MemoryTranscriptReader = SessionTranscriptReader &
  SessionTranscriptVisitor & {
    subagentCoordination: SubagentCoordinationDisplayResolver;
    prepareVisibility(messages: unknown[]): Promise<void>;
  };

/** Adapt the selected actor's history operations to the shared Gateway reader contract. */
export function createSessionActorTranscriptReader(
  memory: NonNullable<ReturnType<typeof captureSessionActorTranscriptRead>>,
): MemoryTranscriptReader {
  const read = async <Key extends keyof SessionActorMemoryHistoryReads>(
    type: Key,
    input: SessionActorMemoryHistoryReads[Key]["input"],
    missing: SessionActorMemoryHistoryReads[Key]["output"],
    signal?: AbortSignal,
  ): Promise<SessionActorMemoryHistoryReads[Key]["output"]> => {
    signal?.throwIfAborted();
    const value = memory.missing ? missing : await memory.read(type, structuredClone(input));
    signal?.throwIfAborted();
    memory.assertCurrent();
    return value;
  };
  const sources = new Map<string, boolean>();
  const runs = new Map<string, Map<number | undefined, boolean>>();
  const subagentCoordination: SubagentCoordinationDisplayResolver = {
    assertCurrent: memory.assertCurrent,
    isSubagentSession(sessionKey) {
      const hidden = sources.get(sessionKey);
      if (hidden === undefined) {
        throw new Error("Session history source visibility was not prepared");
      }
      return hidden;
    },
    isSubagentRunMessage(runId, seq) {
      if (seq === undefined) {
        return false;
      }
      const hidden = runs.get(runId)?.get(seq);
      if (hidden === undefined) {
        throw new Error("Session history run visibility was not prepared");
      }
      return hidden;
    },
  };
  const prepareVisibility = async (messages: unknown[]) => {
    const requested = prepareSessionHistorySubagentFacts(
      { isSubagentSession: () => false, isSubagentRunMessage: () => false },
      (recording) => {
        for (const message of messages) {
          createChatHistoryRecoveryProjection({ subagentCoordination: recording }).append([
            message,
          ]);
        }
      },
    );
    const runIds = [...new Set(requested.runMessages.map(([runId]) => runId))];
    const inputs =
      runIds.length && !memory.missing
        ? await memory.read("session.history.visibility-inputs", { runIds })
        : [];
    const sourceKeys = new Set(requested.sessions.map(([key]) => key));
    for (const { message } of inputs) {
      isSubagentCoordinationHistoryInput(message, (key) => {
        sourceKeys.add(key);
        return false;
      });
    }
    for (const sessionKey of sourceKeys) {
      if (isSubagentSessionFromEntry(sessionKey, undefined)) {
        sources.set(sessionKey, true);
        sourceKeys.delete(sessionKey);
      }
    }
    if (sourceKeys.size) {
      const [{ readAcpSessionEntryAsync }, { getRuntimeConfig }] = await Promise.all([
        import("../acp/runtime/session-meta-read.js"),
        import("../config/io.runtime.js"),
      ]);
      const cfg = getRuntimeConfig();
      await Promise.all(
        [...sourceKeys].map(async (sessionKey) => {
          const source = await readAcpSessionEntryAsync({
            sessionKey,
            cfg,
            env: memory.target.env,
            assertCurrent: memory.assertCurrent,
          });
          sources.set(
            sessionKey,
            isSubagentSessionFromEntry(sessionKey, source?.entry, source?.acp),
          );
        }),
      );
    }
    for (const [runId, messageSeq] of requested.runMessages) {
      const inputKey = buildRunUserTurnIdempotencyKey(runId);
      const anchor = inputs.find(
        ({ message }) =>
          (message.idempotencyKey ?? message.__openclaw.idempotencyKey) === inputKey &&
          !message.__openclaw.steerTargetRunId,
      );
      const hidden = Boolean(
        messageSeq !== undefined &&
        anchor &&
        isSubagentCoordinationHistoryInput(
          anchor.message,
          subagentCoordination.isSubagentSession,
        ) &&
        !inputs.some(
          ({ seq, message }) =>
            seq > anchor.seq &&
            seq <= messageSeq &&
            (message.__openclaw.steerTargetRunId === runId ||
              readSessionTranscriptRunId(message) === runId) &&
            !isSubagentCoordinationHistoryInput(message, subagentCoordination.isSubagentSession),
        ),
      );
      let bySequence = runs.get(runId);
      if (!bySequence) {
        bySequence = new Map();
        runs.set(runId, bySequence);
      }
      bySequence.set(messageSeq, hidden);
    }
    memory.assertCurrent();
  };
  const readMessages = async <T extends { messages: unknown[] }>(operation: Promise<T>) => {
    const value = await operation;
    await prepareVisibility(value.messages);
    return value;
  };
  const reader: MemoryTranscriptReader = {
    subagentCoordination,
    prepareVisibility,
    readSessionMessageCountAsync: () => read("session.history.count", {}, 0),
    readSessionMessagesWithSourceAsync: (_scope, options, signal) =>
      readMessages(read("session.history.source", { options }, { messages: [] }, signal)),
    readRecentSessionMessagesWithStatsAsync: (_scope, options) =>
      readMessages(read("session.history.recent", { options }, { messages: [], totalMessages: 0 })),
    readSessionMessagesPageWithStatsAsync: (_scope, options, signal) =>
      readMessages(
        read("session.history.page", { options }, { messages: [], totalMessages: 0 }, signal),
      ),
    readSessionMessagesAroundIdWithStatsAsync: (_scope, options, signal) =>
      readMessages(
        read(
          "session.history.around-id",
          { options },
          { found: false, messages: [], totalMessages: 0, hasOverreadContext: false, offset: 0 },
          signal,
        ),
      ),
    async readSessionMessageByIdAsync(scope, messageId, options, signal) {
      const captured = options && structuredClone(options);
      const selected = await read(
        "session.history.by-id",
        { messageId, options: captured },
        { found: false, oversized: false },
        signal,
      );
      await prepareVisibility(
        [selected.message, selected.historyContext?.precedingMessage].filter(
          (message) => asOptionalRecord(message) !== undefined,
        ),
      );
      const value = await filterSessionMessageHistoryVisibility(
        selected,
        scope,
        messageId,
        captured?.historyVisibility,
        reader,
      );
      signal?.throwIfAborted();
      memory.assertCurrent();
      return value;
    },
    async readSessionMessagesMatchingIdAsync(_scope, messageId) {
      return (
        await readMessages(
          read(
            "session.history.lookup",
            { messageId },
            { messages: [], hasDisplayMessages: false },
          ),
        )
      ).messages;
    },
    async visitSessionMessagesAsync(_scope, visit) {
      let count = 0;
      let offset: number | undefined;
      do {
        const page = await read("session.history.visitor-source", { offset }, { messages: [] });
        for (const { message, seq } of page.messages) {
          memory.assertCurrent();
          visit(message, seq);
          count++;
        }
        offset = page.nextOffset;
      } while (offset !== undefined);
      return count;
    },
  };
  return reader;
}

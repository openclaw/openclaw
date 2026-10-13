import type { SessionActorMemoryHistoryReads } from "../config/sessions/session-actor-memory-history-contract.js";
import type { captureSessionActorTranscriptRead } from "../config/sessions/session-actor-transcript-read.js";
import { filterSessionMessageHistoryVisibility } from "./session-transcript-read-kernel.js";
import type {
  SessionTranscriptReader,
  SessionTranscriptVisitor,
} from "./session-transcript-read.types.js";

/** Adapt the selected actor's history operations to the shared Gateway reader contract. */
export function createSessionActorTranscriptReader(
  memory: NonNullable<ReturnType<typeof captureSessionActorTranscriptRead>>,
): SessionTranscriptReader & SessionTranscriptVisitor {
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
  const reader: SessionTranscriptReader & SessionTranscriptVisitor = {
    readSessionMessageCountAsync: () => read("session.history.count", {}, 0),
    readSessionMessagesWithSourceAsync: (_scope, options, signal) =>
      read("session.history.source", { options }, { messages: [] }, signal),
    readRecentSessionMessagesWithStatsAsync: (_scope, options) =>
      read("session.history.recent", { options }, { messages: [], totalMessages: 0 }),
    readSessionMessagesPageWithStatsAsync: (_scope, options, signal) =>
      read("session.history.page", { options }, { messages: [], totalMessages: 0 }, signal),
    readSessionMessagesAroundIdWithStatsAsync: (_scope, options, signal) =>
      read(
        "session.history.around-id",
        { options },
        { found: false, messages: [], totalMessages: 0, hasOverreadContext: false, offset: 0 },
        signal,
      ),
    async readSessionMessageByIdAsync(scope, messageId, options, signal) {
      const captured = options && structuredClone(options);
      const selected = await read(
        "session.history.by-id",
        { messageId, options: captured },
        { found: false, oversized: false },
        signal,
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
        await read(
          "session.history.lookup",
          { messageId },
          { messages: [], hasDisplayMessages: false },
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

import type {
  ChatHistoryDisplayRequest,
  ChatHistoryDisplayResult,
  SessionHistorySubagentFacts,
} from "../config/sessions/session-history-types.js";
import type { WorkerTaskChannel } from "../infra/worker-task-server.js";
import type { CliHistoryReaders } from "./cli-session-history.js";
import { createPreparedSessionHistorySubagentProjection } from "./session-history-delta-visibility.js";
import type {
  SessionTranscriptPageOptions,
  SessionTranscriptPageReader,
} from "./session-transcript-read.types.js";

export type ProcessHeldCliHistoryRequest =
  | {
      kind: "by-id";
      messageId: string;
      options: Parameters<SessionTranscriptPageReader["readSessionMessageByIdAsync"]>[2];
    }
  | { kind: "page"; options: SessionTranscriptPageOptions }
  | {
      kind: "around";
      options: Parameters<
        SessionTranscriptPageReader["readSessionMessagesAroundIdWithStatsAsync"]
      >[1];
    };

export async function readProcessHeldCliHistoryInWorker(
  history: ChatHistoryDisplayRequest,
  channel: WorkerTaskChannel,
): Promise<ChatHistoryDisplayResult> {
  const params = history.params;
  const facts: SessionHistorySubagentFacts = { sessions: [], runMessages: [] };
  let subagents = createPreparedSessionHistorySubagentProjection(facts, () => {});
  const request = async <T>(value: ProcessHeldCliHistoryRequest): Promise<T> => {
    const response = await channel.request(value);
    try {
      // SAFETY: The paired host owns this typed response and validates the retained source before disclosure.
      const reply = response.input as { result: T; facts: SessionHistorySubagentFacts };
      facts.sessions.push(...reply.facts.sessions);
      facts.runMessages.push(...reply.facts.runMessages);
      subagents = createPreparedSessionHistorySubagentProjection(facts, () => {});
      return reply.result;
    } finally {
      response.consumed();
    }
  };
  const readers: CliHistoryReaders = {
    subagentCoordination: {
      isSubagentSession: (key) => subagents.isSubagentSession(key),
      isSubagentRunMessage: (runId, seq) => subagents.isSubagentRunMessage(runId, seq),
    },
    readSessionMessageByIdAsync: (_scope, messageId, options) =>
      request({ kind: "by-id", messageId, options }),
    readRecentSessionMessagesWithStatsAsync: (_scope, options) =>
      request({ kind: "page", options: { ...options, offset: 0 } }),
    readSessionMessagesPageWithStatsAsync: (_scope, options) => request({ kind: "page", options }),
    readSessionMessagesAroundIdWithStatsAsync: (_scope, options) =>
      request({ kind: "around", options }),
  };
  const [
    { prepareCliSessionHistoryReader, readChatHistoryMessageFromReaders },
    { readChatHistoryPageKernel },
  ] = await Promise.all([
    import("./cli-session-history.js"),
    import("./chat-history-page-kernel.js"),
  ]);
  if (history.kind === "rpc-message") {
    return {
      kind: "rpc-message",
      result: await readChatHistoryMessageFromReaders(history.params, readers),
    };
  }
  const cli = await prepareCliSessionHistoryReader(params, readers);
  try {
    const page = await readChatHistoryPageKernel(params, {
      readers: cli?.readers ?? readers,
      deferProfileDisplay: true,
      // The host refreshes forwarded labels after the complete page returns.
      resolveCronJobName: () => undefined,
      readMessageSequence: cli?.sequence,
    });
    cli?.applyPagination(page);
    return { kind: "rpc", page };
  } finally {
    cli?.dispose();
  }
}

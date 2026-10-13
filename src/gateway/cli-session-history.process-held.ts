import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { captureSessionActorTranscriptRead } from "../config/sessions/session-actor-transcript-read.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
  ChatHistoryMessageParams,
  ChatHistoryDisplayRequest,
  ChatHistoryDisplayResult,
  SessionHistorySubagentFacts,
} from "../config/sessions/session-history-types.js";
import type { WorkerTaskChannel } from "../infra/worker-task-server.js";
import { createChatHistoryRecoveryProjection } from "./chat-display-projection.core.js";
import type { CliHistoryReaders } from "./cli-session-history.js";
import { projectChatHistoryWithReplies } from "./server-methods/chat-history-reply-messages.js";
import {
  createPreparedSessionHistorySubagentProjection,
  prepareSessionHistorySubagentFacts,
} from "./session-history-delta-visibility.js";
import { createSessionActorTranscriptReader } from "./session-transcript-memory-reader.js";
import type {
  SessionTranscriptPageOptions,
  SessionTranscriptPageReader,
} from "./session-transcript-read.types.js";

type MemoryHistoryRead = NonNullable<ReturnType<typeof captureSessionActorTranscriptRead>>;

type Request =
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

/** Read canonical memory history from its actor while CLI matching stays in a compute worker. */
export async function readProcessHeldCliHistory(
  params: ChatHistoryPageParams,
  signal?: AbortSignal,
  memory?: MemoryHistoryRead,
): Promise<ChatHistoryPage> {
  const result = await readProcessHeldCliHistoryQuery({ kind: "rpc", params }, signal, memory);
  if (result.kind !== "rpc") {
    throw new Error("Unexpected process-held history page");
  }
  return result.page;
}

export async function readProcessHeldCliHistoryMessage(
  params: ChatHistoryMessageParams,
  memory?: MemoryHistoryRead,
) {
  const result = await readProcessHeldCliHistoryQuery(
    { kind: "rpc-message", params },
    undefined,
    memory,
  );
  if (result.kind !== "rpc-message") {
    throw new Error("Unexpected process-held history message");
  }
  return result.result;
}

async function readProcessHeldCliHistoryQuery(
  input: ChatHistoryDisplayRequest,
  signal?: AbortSignal,
  memory?: MemoryHistoryRead,
): Promise<ChatHistoryDisplayResult> {
  const history = structuredClone(input);
  const params = history.params;
  params.encodeResponse = false;
  if (!memory) {
    throw new Error("Process-held history requires a memory session actor");
  }
  if (params.entry) {
    params.entry.incognito = true;
  }
  const { runProcessHeldHistoryTask } =
    await import("../config/sessions/session-transcript-worker-runtime.js");
  const readers = createSessionActorTranscriptReader(memory);
  const scope = {
    agentId: params.sessionAgentId,
    sessionId: params.sessionId!,
    sessionKey: params.canonicalKey,
    storePath: params.storePath,
    sessionEntry: params.entry,
  };
  const assertCurrent = () => {
    signal?.throwIfAborted();
    memory.assertCurrent();
  };
  const result = await runProcessHeldHistoryTask(
    history,
    async (value, { signal: requestSignal }) => {
      requestSignal.throwIfAborted();
      assertCurrent();
      // SAFETY: The paired worker constructs this closed protocol; the host fixes and validates the source target.
      const request = value as Request;
      const readResult =
        request.kind === "page"
          ? await readers.readSessionMessagesPageWithStatsAsync(
              scope,
              request.options,
              requestSignal,
            )
          : request.kind === "around"
            ? await readers.readSessionMessagesAroundIdWithStatsAsync(
                scope,
                request.options,
                requestSignal,
              )
            : await readers.readSessionMessageByIdAsync(
                scope,
                request.messageId,
                request.options,
                requestSignal,
              );
      requestSignal.throwIfAborted();
      if (readResult === undefined) {
        throw new Error("Unsupported process-held history request");
      }
      assertCurrent();
      const messages =
        "messages" in readResult
          ? readResult.messages
          : readResult.message === undefined
            ? []
            : [readResult.message];
      const facts = prepareSessionHistorySubagentFacts(
        readers.subagentCoordination,
        (recording) => {
          for (const message of messages) {
            createChatHistoryRecoveryProjection({ subagentCoordination: recording }).append([
              message,
            ]);
          }
        },
      );
      return { input: { result: readResult, facts }, timeoutMs: 60_000 };
    },
    signal,
  );
  assertCurrent();
  if (result.kind === "rpc-message") {
    return result;
  }
  const page = result.page;
  const [{ createCurrentUserProfileMessageProjector }, { resolveCurrentUserProfileDisplay }] =
    await Promise.all([
      import("./chat-display-projection.core.js"),
      import("./current-user-profile-display.js"),
    ]);
  const project = createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay);
  page.messages = await projectChatHistoryWithReplies(
    page.messages.filter((message): message is Record<string, unknown> =>
      Boolean(asOptionalRecord(message)),
    ),
    (messages) => messages.map(project),
  );
  assertCurrent();
  return { kind: "rpc", page };
}

export async function readProcessHeldCliHistoryInWorker(
  history: ChatHistoryDisplayRequest,
  channel: WorkerTaskChannel,
): Promise<ChatHistoryDisplayResult> {
  const params = history.params;
  const facts: SessionHistorySubagentFacts = { sessions: [], runMessages: [] };
  let subagents = createPreparedSessionHistorySubagentProjection(facts, () => {});
  const request = async <T>(value: Request): Promise<T> => {
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
    import("./server-methods/chat-history-page-kernel.js"),
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
      readMessageSequence: cli?.sequence,
    });
    cli?.applyPagination(page);
    return { kind: "rpc", page };
  } finally {
    cli?.dispose();
  }
}

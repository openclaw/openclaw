import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { captureNativeSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
} from "../config/sessions/session-history-types.js";
import type { WorkerTaskChannel } from "../infra/worker-task-server.js";
import type { CliHistoryReaders } from "./cli-session-history.js";
import type { SessionTranscriptPageReader } from "./session-transcript-read-kernel.js";
import type { SessionTranscriptPageOptions } from "./session-transcript-read.types.js";

type Request =
  | { kind: "page"; options: SessionTranscriptPageOptions }
  | {
      kind: "around";
      options: Parameters<
        SessionTranscriptPageReader["readSessionMessagesAroundIdWithStatsAsync"]
      >[1];
    };

/** Keep process-held SQLite custody on its existing owner; move matching and projection off-loop. */
export async function readProcessHeldCliHistory(
  inputParams: ChatHistoryPageParams,
  signal?: AbortSignal,
): Promise<ChatHistoryPage> {
  const params = structuredClone(inputParams);
  const [{ runProcessHeldHistoryTask }, readers] = await Promise.all([
    import("../config/sessions/session-transcript-worker-runtime.js"),
    import("./session-transcript-readers.js"),
  ]);
  const scope = {
    agentId: params.sessionAgentId,
    sessionId: params.sessionId!,
    sessionKey: params.canonicalKey,
    storePath: params.storePath,
    sessionEntry: params.entry,
  };
  const current = captureNativeSessionEntryCurrentRead(scope);
  const initial = current.readCurrent();
  if (
    !initial ||
    initial.sessionId !== scope.sessionId ||
    initial.lifecycleRevision !== params.entry?.lifecycleRevision
  ) {
    throw new Error("Incognito history session is no longer current");
  }
  const assertCurrent = () => {
    signal?.throwIfAborted();
    const entry = current.readCurrent();
    if (
      entry?.sessionId !== initial.sessionId ||
      entry?.lifecycleRevision !== initial.lifecycleRevision
    ) {
      throw new Error("Incognito history session generation is no longer current");
    }
  };
  assertCurrent();
  const page = await runProcessHeldHistoryTask(
    { ...params, encodeResponse: false },
    async (value) => {
      signal?.throwIfAborted();
      assertCurrent();
      // SAFETY: The paired worker constructs this closed protocol; the host fixes and validates the source target.
      const request = value as Request;
      const input =
        request.kind === "page"
          ? await readers.readSessionMessagesPageWithStatsAsync(scope, request.options)
          : request.kind === "around"
            ? await readers.readSessionMessagesAroundIdWithStatsAsync(scope, request.options)
            : undefined;
      if (input === undefined) {
        throw new Error("Unsupported process-held history request");
      }
      assertCurrent();
      return { input, timeoutMs: 60_000 };
    },
    signal,
  );
  assertCurrent();
  const [{ createCurrentUserProfileMessageProjector }, { resolveCurrentUserProfileDisplay }] =
    await Promise.all([
      import("./chat-display-projection.core.js"),
      import("./current-user-profile-display.js"),
    ]);
  const project = createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay);
  page.messages = page.messages.map((message) => {
    const record = asOptionalRecord(message);
    return record ? project(record) : message;
  });
  assertCurrent();
  return page;
}

export async function readProcessHeldCliHistoryInWorker(
  params: ChatHistoryPageParams,
  channel: WorkerTaskChannel,
): Promise<ChatHistoryPage> {
  const request = async <T>(value: Request): Promise<T> => {
    const response = await channel.request(value);
    try {
      // SAFETY: The paired host owns this typed response and validates the retained source before disclosure.
      return response.input as T;
    } finally {
      response.consumed();
    }
  };
  const readers: CliHistoryReaders = {
    readRecentSessionMessagesWithStatsAsync: (_scope, options) =>
      request({ kind: "page", options: { ...options, offset: 0 } }),
    readSessionMessagesPageWithStatsAsync: (_scope, options) => request({ kind: "page", options }),
    readSessionMessagesAroundIdWithStatsAsync: (_scope, options) =>
      request({ kind: "around", options }),
  };
  const [{ prepareCliSessionHistoryReader }, { readChatHistoryPageKernel }] = await Promise.all([
    import("./cli-session-history.js"),
    import("./server-methods/chat-history-page-kernel.js"),
  ]);
  const cli = await prepareCliSessionHistoryReader(params, readers);
  try {
    const page = await readChatHistoryPageKernel(params, {
      readers: cli?.readers ?? readers,
      deferProfileDisplay: true,
      readMessageSequence: cli?.sequence,
    });
    cli?.applyPagination(page);
    return page;
  } finally {
    cli?.dispose();
  }
}

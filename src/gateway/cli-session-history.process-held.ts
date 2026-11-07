import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { captureSessionActorTranscriptRead } from "../config/sessions/session-actor-transcript-read.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
  ChatHistoryMessageParams,
  ChatHistoryDisplayRequest,
  ChatHistoryDisplayResult,
} from "../config/sessions/session-history-types.js";
import { isNativeHistoryAuthorizationRequest } from "../config/sessions/session-history-types.js";
import { createChatHistoryRecoveryProjection } from "./chat-display-projection.core.js";
import { projectChatHistoryWithReplies } from "./chat-history-reply-messages.js";
import type { ProcessHeldCliHistoryRequest } from "./cli-session-history.process-held.worker.js";
import { prepareSessionHistorySubagentFacts } from "./session-history-delta-visibility.js";
import { createSessionActorTranscriptReader } from "./session-transcript-memory-reader.js";

type MemoryHistoryRead = NonNullable<ReturnType<typeof captureSessionActorTranscriptRead>>;

type NativeHistoryAuthorityAssertion = () => Promise<void>;

/** Read canonical memory history from its actor while CLI matching stays in a compute worker. */
export async function readProcessHeldCliHistory(
  params: ChatHistoryPageParams,
  signal?: AbortSignal,
  memory?: MemoryHistoryRead,
  assertNativeHistoryAuthorized?: NativeHistoryAuthorityAssertion,
): Promise<ChatHistoryPage> {
  const result = await readProcessHeldCliHistoryQuery(
    { kind: "rpc", params },
    signal,
    memory,
    assertNativeHistoryAuthorized,
  );
  if (result.kind !== "rpc") {
    throw new Error("Unexpected process-held history page");
  }
  return result.page;
}

export async function readProcessHeldCliHistoryMessage(
  params: ChatHistoryMessageParams,
  memory?: MemoryHistoryRead,
  assertNativeHistoryAuthorized?: NativeHistoryAuthorityAssertion,
) {
  const result = await readProcessHeldCliHistoryQuery(
    { kind: "rpc-message", params },
    undefined,
    memory,
    assertNativeHistoryAuthorized,
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
  assertNativeHistoryAuthorized?: NativeHistoryAuthorityAssertion,
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
      if (isNativeHistoryAuthorizationRequest(value)) {
        if (!assertNativeHistoryAuthorized) {
          throw new Error("Process-held native history requires Gateway authorization");
        }
        await assertNativeHistoryAuthorized();
        assertCurrent();
        return { input: null, timeoutMs: 60_000 };
      }
      const request = decodeProcessHeldHistoryRequest(value);
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
  const [
    { createCurrentUserProfileMessageProjector },
    { resolveCurrentUserProfileDisplay },
    { getUserProfileDisplay },
  ] = await Promise.all([
    import("./chat-display-projection.core.js"),
    import("./current-user-profile-display.js"),
    import("../state/user-profile-list.js"),
  ]);
  const project = createCurrentUserProfileMessageProjector((id) =>
    resolveCurrentUserProfileDisplay(id, getUserProfileDisplay),
  );
  page.messages = await projectChatHistoryWithReplies(
    page.messages.filter((message): message is Record<string, unknown> =>
      Boolean(asOptionalRecord(message)),
    ),
    (messages) => messages.map(project),
  );
  assertCurrent();
  return { kind: "rpc", page };
}

/** The host fixes the source target; the worker only chooses one of the closed read variants. */
function decodeProcessHeldHistoryRequest(value: unknown): ProcessHeldCliHistoryRequest {
  const record = asOptionalRecord(value);
  if (
    !record ||
    !asOptionalRecord(record.options) ||
    !(
      record.kind === "page" ||
      record.kind === "around" ||
      (record.kind === "by-id" && typeof record.messageId === "string")
    )
  ) {
    throw new Error("Unsupported process-held history request");
  }
  // SAFETY: The closed variant tag, required id and options record were validated above.
  return record as ProcessHeldCliHistoryRequest;
}

import os from "node:os";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAuthorizedClaudeCliBinding } from "../../agents/cli-runner/child-env.js";
import { readLegacyCompactionMetrics } from "../../config/sessions/legacy-compaction-history.js";
import { captureSessionActorTranscriptRead } from "../../config/sessions/session-actor-transcript-read.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
  ChatHistoryMessageParams,
} from "../../config/sessions/session-history-types.js";
import {
  NATIVE_HISTORY_AUTHORIZATION_DENIED,
  isNativeHistoryAuthorizationDenied,
  isNativeHistoryAuthorizationRequest,
} from "../../config/sessions/session-history-types.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import {
  prepareForwardedMessageCronJobNameResolver,
  projectForwardedMessages,
} from "../chat-display-projection.history.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import { createSessionActorTranscriptReader } from "../session-transcript-memory-reader.js";
import * as sessionTranscriptReaders from "../session-transcript-readers.js";
import { readChatHistoryPageKernel } from "./chat-history-page-kernel.js";
import { projectChatHistoryWithReplies } from "./chat-history-reply-messages.js";
import { encodeChatHistoryResponsePage } from "./chat-history-response-page.js";

// Kept outside worker params: the consumer retains this guard until publication,
// without serializing callbacks or attaching native authority to canonical fallbacks.
type RetainNativeHistoryAuthorization = (isCurrent: () => boolean) => void;

/** Native Claude history is readable only while the current environment still selects its root. */
function prepareChatHistoryParams<Params extends ChatHistoryPageParams>(input: Params) {
  const authorize = () =>
    input.ignoreCliSessionImports
      ? undefined
      : resolveAuthorizedClaudeCliBinding({
          entry: input.entry,
          agentId: input.sessionAgentId,
          cwd: input.cwd,
        });
  const authorization = authorize();
  const params: Params = authorization
    ? {
        ...input,
        cliHistoryHomeDir: process.env.HOME || os.homedir(),
        cliHistoryProjectsRoot: authorization.transcriptRoot,
      }
    : { ...input, ignoreCliSessionImports: true };
  const sameAuthorization = () =>
    !authorization || JSON.stringify(authorize()) === JSON.stringify(authorization);
  const assertNativeHistoryAuthorized = async () => {
    if (!authorization || !sameAuthorization()) {
      throw new Error(NATIVE_HISTORY_AUTHORIZATION_DENIED);
    }
  };
  const onNativeHistoryAuthorizationRequest = async (value: unknown) => {
    if (!isNativeHistoryAuthorizationRequest(value)) {
      throw new Error("Unsupported native history authorization request");
    }
    await assertNativeHistoryAuthorized();
  };
  return {
    params,
    native: Boolean(authorization),
    sameAuthorization,
    assertNativeHistoryAuthorized,
    onNativeHistoryAuthorizationRequest,
  };
}

// A native read denied after the effective profile changed falls back to
// canonical history; any other failure surfaces unchanged.
async function readNativeHistory<T>(
  sameAuthorization: () => boolean,
  read: () => Promise<T>,
): Promise<{ result: T } | undefined> {
  try {
    return { result: await read() };
  } catch (error) {
    if (isNativeHistoryAuthorizationDenied(error) && !sameAuthorization()) {
      return undefined;
    }
    throw error;
  }
}

function chatHistoryScope(params: ChatHistoryPageParams) {
  return {
    agentId: params.sessionAgentId,
    sessionId: params.sessionId ?? "",
    sessionKey: params.canonicalKey,
    storePath: params.storePath,
    sessionEntry: params.entry,
  };
}

export async function readChatHistoryMessageById(
  input: ChatHistoryMessageParams,
  retainNativeHistoryAuthorization?: RetainNativeHistoryAuthorization,
) {
  const scope = chatHistoryScope(input);
  const memory = captureSessionActorTranscriptRead(scope);
  const captured = memory ? structuredClone(input) : input;
  const {
    params,
    native,
    sameAuthorization,
    assertNativeHistoryAuthorized,
    onNativeHistoryAuthorizationRequest,
  } = prepareChatHistoryParams(captured);
  const readCanonical = async () => {
    const readers = memory ? createSessionActorTranscriptReader(memory) : sessionTranscriptReaders;
    const result = await readers.readSessionMessageByIdAsync(scope, captured.messageId, {
      allowResetArchiveFallback: true,
      historyVisibility: { sessionStartedAt: captured.entry?.sessionStartedAt },
    });
    memory?.assertCurrent();
    return result;
  };
  if (memory && native) {
    const { readProcessHeldCliHistoryMessage } =
      await import("../cli-session-history.process-held.js");
    const resolved = await readNativeHistory(sameAuthorization, () =>
      readProcessHeldCliHistoryMessage(params, memory, assertNativeHistoryAuthorized),
    );
    memory.assertCurrent();
    if (!resolved || !sameAuthorization()) {
      return readCanonical();
    }
    retainNativeHistoryAuthorization?.(sameAuthorization);
    return resolved.result;
  }
  const storePath = input.storePath;
  if (
    memory ||
    !native ||
    !storePath ||
    input.entry?.incognito ||
    isIncognitoSessionKey(input.canonicalKey)
  ) {
    return readCanonical();
  }
  const { readSessionHistoryPageInWorker } =
    await import("../../config/sessions/session-history-worker-runtime.js");
  const resolved = await readNativeHistory(sameAuthorization, () =>
    readSessionHistoryPageInWorker(
      { kind: "rpc-message", params: { ...params, storePath } },
      undefined,
      onNativeHistoryAuthorizationRequest,
    ),
  );
  if (!resolved || !sameAuthorization()) {
    return readCanonical();
  }
  retainNativeHistoryAuthorization?.(sameAuthorization);
  return resolved.result;
}

export async function readChatHistoryPage(
  input: ChatHistoryPageParams,
  signal?: AbortSignal,
  retainNativeHistoryAuthorization?: RetainNativeHistoryAuthorization,
): Promise<ChatHistoryPage> {
  signal?.throwIfAborted();
  const scope = chatHistoryScope(input);
  const memory = captureSessionActorTranscriptRead(scope, signal);
  const {
    params: prepared,
    sameAuthorization,
    assertNativeHistoryAuthorized,
    onNativeHistoryAuthorizationRequest,
  } = prepareChatHistoryParams(memory ? structuredClone(input) : input);
  const readPage = async (params: ChatHistoryPageParams): Promise<ChatHistoryPage> => {
    signal?.throwIfAborted();
    const useCliHistory = !params.ignoreCliSessionImports;
    const readCanonicalFallback = () => readPage({ ...params, ignoreCliSessionImports: true });
    if (useCliHistory && !sameAuthorization()) {
      return readCanonicalFallback();
    }
    if (memory) {
      let page: ChatHistoryPage;
      if (useCliHistory) {
        const { readProcessHeldCliHistory } =
          await import("../cli-session-history.process-held.js");
        const resolved = await readNativeHistory(sameAuthorization, () =>
          readProcessHeldCliHistory(params, signal, memory, assertNativeHistoryAuthorized),
        );
        if (!resolved) {
          return readCanonicalFallback();
        }
        page = resolved.result;
      } else {
        page = await readChatHistoryPageKernel(params, {
          readers: createSessionActorTranscriptReader(memory),
          readOnly: true,
          resolveCurrentUserProfileDisplay,
          resolveCronJobName: () => undefined,
        });
      }
      const refreshed = { ...page, messages: await refreshForwardedLabels(page.messages) };
      signal?.throwIfAborted();
      memory.assertCurrent();
      if (!useCliHistory) {
        return encodeChatHistoryResponsePage(refreshed, params);
      }
      if (!sameAuthorization()) {
        return readCanonicalFallback();
      }
      retainNativeHistoryAuthorization?.(sameAuthorization);
      return refreshed;
    }
    if (
      !params.sessionId ||
      !params.storePath ||
      params.entry?.incognito ||
      isIncognitoSessionKey(params.canonicalKey)
    ) {
      const page = await readChatHistoryPageKernel(params, {
        readers: sessionTranscriptReaders,
        resolveCurrentUserProfileDisplay,
        resolveCronJobName: () => undefined,
      });
      return { ...page, messages: await refreshForwardedLabels(page.messages) };
    }
    const { sessionId, storePath } = params;
    const { readSessionHistoryPageInWorker } =
      await import("../../config/sessions/session-history-worker-runtime.js");
    const resolved = await readNativeHistory(sameAuthorization, () =>
      readSessionHistoryPageInWorker(
        {
          kind: "rpc",
          params: {
            ...params,
            compactionMetrics: readLegacyCompactionMetrics(params.entry),
            sessionId,
            storePath,
          },
        },
        signal,
        onNativeHistoryAuthorizationRequest,
      ),
    );
    if (!resolved) {
      return readCanonicalFallback();
    }
    if (useCliHistory) {
      if (!sameAuthorization()) {
        return readCanonicalFallback();
      }
      retainNativeHistoryAuthorization?.(sameAuthorization);
    }
    return resolved.result;
  };
  return readPage(prepared);
}

async function refreshForwardedLabels(messages: unknown[]): Promise<unknown[]> {
  return projectChatHistoryWithReplies(
    messages.filter(
      (message): message is Record<string, unknown> => asOptionalRecord(message) !== undefined,
    ),
    async (displayMessages) =>
      projectForwardedMessages(
        displayMessages,
        await prepareForwardedMessageCronJobNameResolver(displayMessages),
      ),
  );
}

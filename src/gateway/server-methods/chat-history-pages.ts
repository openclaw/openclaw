import os from "node:os";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAuthorizedClaudeCliBinding } from "../../agents/cli-runner/child-env.js";
import { captureTranscriptRedactionSnapshot } from "../../agents/transcript-redact-text.js";
import { readLegacyCompactionMetrics } from "../../config/sessions/legacy-compaction-history.js";
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
import type { IncognitoSessionHistoryReader } from "../session-history-snapshot.js";
import * as sessionTranscriptReaders from "../session-transcript-readers.js";
import { readChatHistoryPageKernel } from "./chat-history-page-kernel.js";
import { projectChatHistoryWithReplies } from "./chat-history-reply-messages.js";
import { encodeChatHistoryResponsePage } from "./chat-history-response-page.js";

function prepareChatHistoryParams<Params extends ChatHistoryPageParams>(input: Params) {
  const homeDir = process.env.HOME || os.homedir();
  const authorization = !input.ignoreCliSessionImports
    ? resolveAuthorizedClaudeCliBinding({
        entry: input.entry,
        agentId: input.sessionAgentId,
        cwd: input.cwd,
        homeDir,
      })
    : undefined;
  const params = authorization
    ? {
        ...input,
        cliHistoryHomeDir: homeDir,
        cliHistoryRedaction: captureTranscriptRedactionSnapshot(),
        cliHistoryProjectsRoot: authorization.transcriptRoot,
      }
    : { ...input, ignoreCliSessionImports: true };
  const sameAuthorization = () => {
    if (!authorization) {
      return true;
    }
    const currentHomeDir = process.env.HOME || os.homedir();
    const current = resolveAuthorizedClaudeCliBinding({
      entry: input.entry,
      agentId: input.sessionAgentId,
      cwd: input.cwd,
      homeDir: currentHomeDir,
    });
    return JSON.stringify(current) === JSON.stringify(authorization);
  };
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

// Kept outside worker params: the consumer retains this guard until publication,
// without serializing callbacks or attaching native authority to canonical fallbacks.
type RetainNativeHistoryAuthorization = (isCurrent: () => boolean) => void;

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
  suppliedIncognito?: IncognitoSessionHistoryReader,
  retainNativeHistoryAuthorization?: RetainNativeHistoryAuthorization,
) {
  const incognito =
    suppliedIncognito ??
    sessionTranscriptReaders.captureIncognitoSessionHistoryReader(chatHistoryScope(input));
  const source = incognito ? structuredClone(input) : input;
  const {
    params,
    sameAuthorization,
    assertNativeHistoryAuthorized,
    onNativeHistoryAuthorizationRequest,
  } = prepareChatHistoryParams(source);
  const messageOptions = {
    allowResetArchiveFallback: true,
    historyVisibility: { sessionStartedAt: source.entry?.sessionStartedAt },
  };
  if (incognito) {
    const scope = chatHistoryScope(source);
    const outcome = await incognito.consume(scope, async (readers) => {
      const readCanonical = () =>
        readers.readSessionMessageByIdAsync(scope, source.messageId, messageOptions);
      if (params.ignoreCliSessionImports || !sameAuthorization()) {
        return { result: await readCanonical(), native: false };
      }
      const { readProcessHeldCliHistoryMessage } =
        await import("../cli-session-history.process-held.js");
      const native = await readNativeHistory(sameAuthorization, () =>
        readProcessHeldCliHistoryMessage(params, incognito, assertNativeHistoryAuthorized),
      );
      if (!native || !sameAuthorization()) {
        return { result: await readCanonical(), native: false };
      }
      return { result: native.result, native: true };
    });
    if (outcome.native) {
      retainNativeHistoryAuthorization?.(sameAuthorization);
    }
    return outcome.result;
  }
  const readCanonical = () =>
    sessionTranscriptReaders.readSessionMessageByIdAsync(
      chatHistoryScope(input),
      input.messageId,
      messageOptions,
    );
  const storePath = input.storePath;
  if (params.ignoreCliSessionImports || !storePath) {
    return readCanonical();
  }
  if (params.entry?.incognito || isIncognitoSessionKey(params.canonicalKey)) {
    const { readProcessHeldCliHistoryMessage } =
      await import("../cli-session-history.process-held.js");
    if (!sameAuthorization()) {
      return readCanonical();
    }
    const native = await readNativeHistory(sameAuthorization, () =>
      readProcessHeldCliHistoryMessage(params, undefined, assertNativeHistoryAuthorized),
    );
    if (!native || !sameAuthorization()) {
      return readCanonical();
    }
    retainNativeHistoryAuthorization?.(sameAuthorization);
    return native.result;
  }
  const { readSessionHistoryPageInWorker } =
    await import("../../config/sessions/session-history-worker-runtime.js");
  if (!sameAuthorization()) {
    return readCanonical();
  }
  const native = await readNativeHistory(sameAuthorization, () =>
    readSessionHistoryPageInWorker(
      {
        kind: "rpc-message",
        params: { ...params, storePath },
      },
      undefined,
      onNativeHistoryAuthorizationRequest,
    ),
  );
  if (!native || !sameAuthorization()) {
    return readCanonical();
  }
  retainNativeHistoryAuthorization?.(sameAuthorization);
  return native.result;
}

export async function readChatHistoryPage(
  input: ChatHistoryPageParams,
  signal?: AbortSignal,
  suppliedIncognito?: IncognitoSessionHistoryReader,
  retainNativeHistoryAuthorization?: RetainNativeHistoryAuthorization,
): Promise<ChatHistoryPage> {
  signal?.throwIfAborted();
  const incognito =
    suppliedIncognito ??
    (input.sessionId && input.storePath
      ? sessionTranscriptReaders.captureIncognitoSessionHistoryReader(
          chatHistoryScope(input),
          signal,
        )
      : undefined);
  const source = incognito ? structuredClone(input) : input;
  const {
    params,
    sameAuthorization,
    assertNativeHistoryAuthorized,
    onNativeHistoryAuthorizationRequest,
  } = prepareChatHistoryParams(source);
  const readPage = async (pageParams: ChatHistoryPageParams): Promise<ChatHistoryPage> => {
    signal?.throwIfAborted();
    const readCanonicalFallback = () => readPage({ ...source, ignoreCliSessionImports: true });
    if (!sameAuthorization() && !pageParams.ignoreCliSessionImports) {
      return readCanonicalFallback();
    }
    if (incognito) {
      const scope = chatHistoryScope(pageParams);
      if (!pageParams.ignoreCliSessionImports) {
        const page = await incognito.consume(scope, async () => {
          const { readProcessHeldCliHistory } =
            await import("../cli-session-history.process-held.js");
          const native = await readNativeHistory(sameAuthorization, () =>
            readProcessHeldCliHistory(pageParams, signal, incognito, assertNativeHistoryAuthorized),
          );
          if (!native) {
            return undefined;
          }
          const messages = await refreshForwardedLabels(native.result.messages);
          signal?.throwIfAborted();
          return { ...native.result, messages };
        });
        if (!page || !sameAuthorization()) {
          return readCanonicalFallback();
        }
        retainNativeHistoryAuthorization?.(sameAuthorization);
        return page;
      }
      const reader = incognito;
      return reader.consume(scope, async () => {
        const page = await reader.rpc({ ...pageParams, encodeResponse: false });
        const messages = await refreshForwardedLabels(page.messages);
        signal?.throwIfAborted();
        return encodeChatHistoryResponsePage({ ...page, messages }, pageParams);
      });
    }
    if (
      pageParams.sessionId &&
      pageParams.storePath &&
      (pageParams.entry?.incognito || isIncognitoSessionKey(pageParams.canonicalKey)) &&
      !pageParams.ignoreCliSessionImports
    ) {
      const { readProcessHeldCliHistory } = await import("../cli-session-history.process-held.js");
      if (!sameAuthorization()) {
        return readCanonicalFallback();
      }
      const native = await readNativeHistory(sameAuthorization, () =>
        readProcessHeldCliHistory(pageParams, signal, undefined, assertNativeHistoryAuthorized),
      );
      if (!native) {
        return readCanonicalFallback();
      }
      const page = native.result;
      const refreshed = { ...page, messages: await refreshForwardedLabels(page.messages) };
      if (!sameAuthorization()) {
        return readCanonicalFallback();
      }
      retainNativeHistoryAuthorization?.(sameAuthorization);
      return refreshed;
    }
    if (
      !pageParams.sessionId ||
      !pageParams.storePath ||
      pageParams.entry?.incognito ||
      isIncognitoSessionKey(pageParams.canonicalKey)
    ) {
      const page = await readChatHistoryPageKernel(pageParams, {
        readers: sessionTranscriptReaders,
        resolveCurrentUserProfileDisplay,
        resolveCronJobName: () => undefined,
      });
      return { ...page, messages: await refreshForwardedLabels(page.messages) };
    }
    const { sessionId, storePath } = pageParams;
    const { readSessionHistoryPageInWorker } =
      await import("../../config/sessions/session-history-worker-runtime.js");
    if (!sameAuthorization() && !pageParams.ignoreCliSessionImports) {
      return readCanonicalFallback();
    }
    const native = await readNativeHistory(sameAuthorization, () =>
      readSessionHistoryPageInWorker(
        {
          kind: "rpc",
          params: {
            ...pageParams,
            compactionMetrics: readLegacyCompactionMetrics(pageParams.entry),
            sessionId,
            storePath,
          },
        },
        signal,
        onNativeHistoryAuthorizationRequest,
      ),
    );
    if (!native) {
      return readCanonicalFallback();
    }
    if (!sameAuthorization() && !pageParams.ignoreCliSessionImports) {
      return readCanonicalFallback();
    }
    if (!pageParams.ignoreCliSessionImports) {
      retainNativeHistoryAuthorization?.(sameAuthorization);
    }
    return native.result;
  };
  return readPage(params);
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

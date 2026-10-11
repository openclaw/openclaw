import os from "node:os";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { captureTranscriptRedactionSnapshot } from "../../agents/transcript-redact-text.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { readLegacyCompactionMetrics } from "../../config/sessions/legacy-compaction-history.js";
import { captureSessionActorTranscriptRead } from "../../config/sessions/session-actor-transcript-read.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
  ChatHistoryMessageParams,
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

function prepareChatHistoryParams<Params extends ChatHistoryPageParams>(input: Params): Params {
  return getCliSessionBinding(input.entry, "claude-cli")?.sessionId
    ? {
        ...input,
        cliHistoryHomeDir: process.env.HOME || os.homedir(),
        cliHistoryRedaction: captureTranscriptRedactionSnapshot(),
      }
    : input;
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

export async function readChatHistoryMessageById(input: ChatHistoryMessageParams) {
  const scope = chatHistoryScope(input);
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    const captured = structuredClone(input);
    let result;
    if (getCliSessionBinding(captured.entry, "claude-cli")?.sessionId) {
      const { readProcessHeldCliHistoryMessage } =
        await import("../cli-session-history.process-held.js");
      result = await readProcessHeldCliHistoryMessage(prepareChatHistoryParams(captured), memory);
    } else {
      result = await createSessionActorTranscriptReader(memory).readSessionMessageByIdAsync(
        scope,
        captured.messageId,
        {
          allowResetArchiveFallback: true,
          historyVisibility: { sessionStartedAt: captured.entry?.sessionStartedAt },
        },
      );
    }
    memory.assertCurrent();
    return result;
  }
  const binding = getCliSessionBinding(input.entry, "claude-cli");
  if (
    !binding?.sessionId ||
    !input.storePath ||
    input.entry?.incognito ||
    isIncognitoSessionKey(input.canonicalKey)
  ) {
    return sessionTranscriptReaders.readSessionMessageByIdAsync(
      chatHistoryScope(input),
      input.messageId,
      {
        allowResetArchiveFallback: true,
        historyVisibility: { sessionStartedAt: input.entry?.sessionStartedAt },
      },
    );
  }
  const params = prepareChatHistoryParams(input);
  const { readSessionHistoryPageInWorker } =
    await import("../../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker({
    kind: "rpc-message",
    params: { ...params, storePath: input.storePath },
  });
}

export async function readChatHistoryPage(
  input: ChatHistoryPageParams,
  signal?: AbortSignal,
): Promise<ChatHistoryPage> {
  signal?.throwIfAborted();
  const scope = chatHistoryScope(input);
  const memory = captureSessionActorTranscriptRead(scope, signal);
  const binding = getCliSessionBinding(input.entry, "claude-cli");
  const params = prepareChatHistoryParams(memory ? structuredClone(input) : input);
  if (memory) {
    const useCliHistory = Boolean(binding?.sessionId && !params.ignoreCliSessionImports);
    let page: ChatHistoryPage;
    if (useCliHistory) {
      const { readProcessHeldCliHistory } = await import("../cli-session-history.process-held.js");
      page = await readProcessHeldCliHistory(params, signal, memory);
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
    return useCliHistory ? refreshed : encodeChatHistoryResponsePage(refreshed, params);
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
  const { readSessionHistoryPageInWorker } =
    await import("../../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker(
    {
      kind: "rpc",
      params: {
        ...params,
        compactionMetrics: readLegacyCompactionMetrics(params.entry),
        sessionId: params.sessionId,
        storePath: params.storePath,
      },
    },
    signal,
  );
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

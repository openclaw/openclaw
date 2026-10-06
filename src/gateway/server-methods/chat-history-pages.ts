import os from "node:os";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { captureTranscriptRedactionSnapshot } from "../../agents/transcript-redact-text.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { readLegacyCompactionMetrics } from "../../config/sessions/legacy-compaction-history.js";
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
import type { IncognitoSessionHistoryReader } from "../session-history-snapshot.js";
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

export async function readChatHistoryMessageById(
  input: ChatHistoryMessageParams,
  suppliedIncognito?: IncognitoSessionHistoryReader,
) {
  const incognito =
    suppliedIncognito ??
    sessionTranscriptReaders.captureIncognitoSessionHistoryReader({
      agentId: input.sessionAgentId,
      sessionId: input.sessionId,
      sessionKey: input.canonicalKey,
      storePath: input.storePath,
      sessionEntry: input.entry,
    });
  if (incognito) {
    const captured = structuredClone(input);
    return incognito.consume(
      {
        agentId: captured.sessionAgentId,
        sessionId: captured.sessionId,
        sessionKey: captured.canonicalKey,
        storePath: captured.storePath,
        sessionEntry: captured.entry,
      },
      async (readers) => {
        if (getCliSessionBinding(captured.entry, "claude-cli")?.sessionId) {
          const { readProcessHeldCliHistoryMessage } =
            await import("../cli-session-history.process-held.js");
          return readProcessHeldCliHistoryMessage(prepareChatHistoryParams(captured), incognito);
        }
        return readers.readSessionMessageByIdAsync(
          {
            agentId: captured.sessionAgentId,
            sessionId: captured.sessionId,
            sessionKey: captured.canonicalKey,
            storePath: captured.storePath,
            sessionEntry: captured.entry,
          },
          captured.messageId,
          {
            allowResetArchiveFallback: true,
            historyVisibility: { sessionStartedAt: captured.entry?.sessionStartedAt },
          },
        );
      },
    );
  }
  const binding = getCliSessionBinding(input.entry, "claude-cli");
  if (!binding?.sessionId || !input.storePath) {
    return sessionTranscriptReaders.readSessionMessageByIdAsync(
      {
        agentId: input.sessionAgentId,
        sessionId: input.sessionId,
        sessionKey: input.canonicalKey,
        storePath: input.storePath,
        sessionEntry: input.entry,
      },
      input.messageId,
      {
        allowResetArchiveFallback: true,
        historyVisibility: { sessionStartedAt: input.entry?.sessionStartedAt },
      },
    );
  }
  const params = prepareChatHistoryParams(input);
  if (params.entry?.incognito || isIncognitoSessionKey(params.canonicalKey)) {
    const { readProcessHeldCliHistoryMessage } =
      await import("../cli-session-history.process-held.js");
    return readProcessHeldCliHistoryMessage(params);
  }
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
  suppliedIncognito?: IncognitoSessionHistoryReader,
): Promise<ChatHistoryPage> {
  signal?.throwIfAborted();
  const incognito =
    suppliedIncognito ??
    (input.sessionId && input.storePath
      ? sessionTranscriptReaders.captureIncognitoSessionHistoryReader(
          {
            agentId: input.sessionAgentId,
            sessionId: input.sessionId,
            sessionKey: input.canonicalKey,
            storePath: input.storePath,
            sessionEntry: input.entry,
          },
          signal,
        )
      : undefined);
  const binding = getCliSessionBinding(input.entry, "claude-cli");
  const params = prepareChatHistoryParams(incognito ? structuredClone(input) : input);
  if (incognito) {
    if (binding?.sessionId && !params.ignoreCliSessionImports) {
      return incognito.consume(
        {
          agentId: params.sessionAgentId,
          sessionId: params.sessionId ?? "",
          sessionKey: params.canonicalKey,
          storePath: params.storePath,
          sessionEntry: params.entry,
        },
        async () => {
          const { readProcessHeldCliHistory } =
            await import("../cli-session-history.process-held.js");
          const page = await readProcessHeldCliHistory(params, signal, incognito);
          const messages = await refreshForwardedLabels(page.messages);
          signal?.throwIfAborted();
          return { ...page, messages };
        },
      );
    }
    const reader = incognito;
    return reader.consume(
      {
        agentId: params.sessionAgentId,
        sessionId: params.sessionId ?? "",
        sessionKey: params.canonicalKey,
        storePath: params.storePath,
        sessionEntry: params.entry,
      },
      async () => {
        const page = await reader.rpc({ ...params, encodeResponse: false });
        const messages = await refreshForwardedLabels(page.messages);
        signal?.throwIfAborted();
        return encodeChatHistoryResponsePage({ ...page, messages }, params);
      },
    );
  }
  if (
    params.sessionId &&
    params.storePath &&
    (params.entry?.incognito || isIncognitoSessionKey(params.canonicalKey)) &&
    binding?.sessionId &&
    !params.ignoreCliSessionImports
  ) {
    const { readProcessHeldCliHistory } = await import("../cli-session-history.process-held.js");
    const page = await readProcessHeldCliHistory(params, signal);
    return { ...page, messages: await refreshForwardedLabels(page.messages) };
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

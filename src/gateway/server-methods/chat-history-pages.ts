import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readTranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
} from "../../config/sessions/session-history-types.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { augmentChatHistoryWithCanvasBlocks } from "../chat-display-projection.canvas.js";
import {
  projectChatDisplayMessagesWithState,
  createCurrentUserProfileMessageProjector,
} from "../chat-display-projection.core.js";
import {
  dropPreSessionStartAnnouncePairs,
  projectForwardedMessages,
} from "../chat-display-projection.history.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import { createSessionHistorySubagentProjection } from "../session-history-subagent-projection.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import * as sessionTranscriptReaders from "../session-transcript-readers.js";
import { readChatHistoryPageKernel } from "./chat-history-page-kernel.js";

function readCliIdentityProjectionKey(message: unknown): string | undefined {
  const id = readChatHistoryMessageId(message);
  if (id) {
    return `id:${id}`;
  }
  const record = asOptionalRecord(message);
  const meta = asOptionalRecord(record?.["__openclaw"]);
  const position = readTranscriptDisplayPosition(meta?.transcriptPosition);
  if (!record || !position) {
    return undefined;
  }
  return JSON.stringify([position, record.role, record.text, record.content]);
}

function projectCliIdentityOntoPagedMessages(params: {
  pagedMessages: unknown[];
  completeMessages: unknown[];
}): unknown[] {
  const importedMetaByKey = new Map<string, Record<string, unknown>>();
  for (const message of params.completeMessages) {
    const key = readCliIdentityProjectionKey(message);
    const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
    if (key && meta) {
      importedMetaByKey.set(key, meta);
    }
  }
  return params.pagedMessages.map((message) => {
    const record = asOptionalRecord(message);
    const key = readCliIdentityProjectionKey(message);
    const importedMeta = key ? importedMetaByKey.get(key) : undefined;
    if (!record || !importedMeta) {
      return message;
    }
    const localMeta = asOptionalRecord(record["__openclaw"]);
    return {
      ...record,
      __openclaw: {
        ...localMeta,
        importedFrom: importedMeta.importedFrom,
        externalId: importedMeta.externalId,
        cliSessionId: importedMeta.cliSessionId,
      },
    };
  });
}

export async function readChatHistoryPage(
  params: ChatHistoryPageParams,
  signal?: AbortSignal,
): Promise<ChatHistoryPage> {
  signal?.throwIfAborted();
  if (
    !params.sessionId ||
    !params.storePath ||
    params.entry?.incognito ||
    isIncognitoSessionKey(params.canonicalKey) ||
    getCliSessionBinding(params.entry, "claude-cli")?.sessionId
  ) {
    const page = await readChatHistoryPageLocal(params);
    return { ...page, messages: refreshForwardedLabels(page.messages) };
  }
  const { readSessionHistoryPageInWorker } =
    await import("../../config/sessions/session-history-worker-runtime.js");
  const page = await readSessionHistoryPageInWorker(
    {
      kind: "rpc",
      params: {
        ...params,
        sessionId: params.sessionId,
        storePath: params.storePath,
        entry: params.entry
          ? {
              sessionId: params.entry.sessionId,
              updatedAt: params.entry.updatedAt,
              sessionStartedAt: params.entry.sessionStartedAt,
            }
          : undefined,
      },
    },
    signal,
  );
  const project = createCurrentUserProfileMessageProjector(resolveCurrentUserProfileDisplay);
  return {
    ...page,
    messages: refreshForwardedLabels(page.messages).map((message) => {
      const record = asOptionalRecord(message);
      return record ? project(record) : message;
    }),
  };
}

function refreshForwardedLabels(messages: unknown[]): unknown[] {
  return projectForwardedMessages(
    messages.filter(
      (message): message is Record<string, unknown> => asOptionalRecord(message) !== undefined,
    ),
  );
}

async function readChatHistoryPageLocal(params: ChatHistoryPageParams): Promise<ChatHistoryPage> {
  const { entry, provider, effectiveMaxChars, offset, messageId, sessionId, storePath } = params;
  const cliSessionId = params.ignoreCliSessionImports
    ? undefined
    : getCliSessionBinding(entry, "claude-cli")?.sessionId;
  const subagentCoordination =
    sessionId && storePath && !entry?.incognito && !isIncognitoSessionKey(params.canonicalKey)
      ? createSessionHistorySubagentProjection({
          agentId: params.sessionAgentId,
          sessionId,
          sessionKey: params.canonicalKey,
          storePath,
          sessionEntry: entry,
        })
      : undefined;
  const page = await readChatHistoryPageKernel(params, {
    readers: { ...sessionTranscriptReaders, subagentCoordination },
    resolveCurrentUserProfileDisplay,
    ...(cliSessionId
      ? {
          cliSessionId,
          readCliTailPage: async ({
            readScope,
            incrementalTail,
            activeLeafEntryId,
            buildTailPage,
          }) => {
            const localMessagesWithBoundaryFilter = incrementalTail.rawMessages;
            const {
              readChatHistoryCliSessionImportSnapshot,
              resolveChatHistoryWithCliSessionImports,
            } = await import("../cli-session-history.js");
            const importedMessages = await readChatHistoryCliSessionImportSnapshot({
              entry,
              provider,
              localMessages: localMessagesWithBoundaryFilter,
            });
            const cliHistory = resolveChatHistoryWithCliSessionImports({
              entry,
              provider,
              localMessages: localMessagesWithBoundaryFilter,
              preparedImportedMessages: importedMessages,
            });
            if ((offset !== undefined || messageId) && !cliHistory.imported) {
              return readChatHistoryPageLocal({ ...params, ignoreCliSessionImports: true });
            }
            if (cliHistory.expanded || messageId) {
              // Reuse this request's redacted external snapshot after the full local read;
              // re-reading here would duplicate a large import and defeat cross-client singleflight.
              const completeLocalMessages = dropPreSessionStartAnnouncePairs(
                await sessionTranscriptReaders.readSessionMessagesAsync(readScope, {
                  mode: "full",
                  reason: "chat.history CLI import merge",
                  allowResetArchiveFallback: true,
                }),
                typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
              );
              const completeCliHistory = resolveChatHistoryWithCliSessionImports({
                entry,
                provider,
                localMessages: completeLocalMessages,
                preparedImportedMessages: importedMessages,
              });
              if (!completeCliHistory.imported) {
                return readChatHistoryPageLocal({ ...params, ignoreCliSessionImports: true });
              }
              const mergedMessages = dropPreSessionStartAnnouncePairs(
                completeCliHistory.messages,
                typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
              );
              const { messages: displayMessages, activity } = projectChatDisplayMessagesWithState(
                mergedMessages,
                {
                  subagentCoordination,
                  includeCommentaryFallbacks: true,
                  maxChars: effectiveMaxChars,
                  redactInlineMedia: true,
                  resolveCurrentUserProfileDisplay,
                },
              );
              if (!completeCliHistory.expanded && !messageId) {
                // A tail-only merge can look expanded because older imported rows are absent
                // from that local window. Preserve normal local pagination after the full merge
                // proves that the import only contributes identity metadata.
                const localPage = await readChatHistoryPageLocal({
                  ...params,
                  ignoreCliSessionImports: true,
                });
                return {
                  ...localPage,
                  messages: projectCliIdentityOntoPagedMessages({
                    pagedMessages: localPage.messages,
                    completeMessages: displayMessages,
                  }),
                };
              }
              // Import snapshots are terminal, but a missing display anchor is not a tail request.
              if (
                messageId &&
                !displayMessages.some((message) => readChatHistoryMessageId(message) === messageId)
              ) {
                return { messages: [] };
              }
              return {
                activeLeafEntryId,
                messages: augmentChatHistoryWithCanvasBlocks(displayMessages),
                activity,
                completeCliImport: true,
                pagination: {
                  offset: 0,
                  totalMessages: mergedMessages.length,
                  rawPageMessages: mergedMessages.length,
                  exhausted: true,
                },
              };
            }
            const projectedTailMessages = cliHistory.imported
              ? projectCliIdentityOntoPagedMessages({
                  pagedMessages: incrementalTail.projected,
                  completeMessages: cliHistory.messages,
                })
              : incrementalTail.projected;
            return buildTailPage(projectedTailMessages);
          },
        }
      : {}),
  });
  subagentCoordination?.assertCurrent?.();
  return page;
}

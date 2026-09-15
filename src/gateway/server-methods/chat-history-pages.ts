import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readTranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
} from "../../config/sessions/session-history-types.js";
import { resolveSessionTranscriptActiveLeafEntryId } from "../../config/sessions/transcript-tree.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import {
  dropPreSessionStartAnnouncePairs,
  isHeartbeatHistoryTurnBoundaryMessage,
  projectChatDisplayMessages,
  projectChatDisplayMessagesWithState,
  createChatHistoryRecoveryProjection,
  augmentChatHistoryWithCanvasBlocks,
  createCurrentUserProfileMessageProjector,
} from "../chat-display-projection.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import {
  capOffsetChatHistoryProjectedMessages,
  dropChatHistoryOverreadContextMessage,
  readChatHistoryMessageId,
  readChatHistoryRecoveryContext,
  readChatHistoryMessageSeq,
  readIncrementalChatHistoryTail,
  type IncrementalChatHistoryTail,
} from "../session-history-tail.js";
import { readSessionMessagesAroundIdWithStatsAsync } from "../session-transcript-anchor-reader.js";
import {
  readSessionMessagesAsync,
  type ReadRecentSessionMessagesResult,
} from "../session-transcript-readers.js";

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

export function resolveChatHistoryNextOffset(params: {
  messages: unknown[];
  projected: unknown[];
  totalMessages: number;
  offset: number;
  rawPageMessages: number;
}): number {
  let oldestSeq: number | undefined;
  let boundedSiblings = 0;
  for (const message of params.messages) {
    const seq = readChatHistoryMessageSeq(message);
    oldestSeq ??= seq;
    if (seq !== undefined && seq === oldestSeq) {
      boundedSiblings += 1;
    }
  }
  if (oldestSeq === undefined) {
    return params.offset + params.rawPageMessages;
  }
  const recordOffset = params.totalMessages - oldestSeq + 1;
  const replayOffset = recordOffset - 1;
  if (replayOffset > params.offset) {
    let projectedSiblings = 0;
    for (const message of params.projected) {
      if (readChatHistoryMessageSeq(message) === oldestSeq) {
        projectedSiblings += 1;
        if (projectedSiblings > boundedSiblings) {
          return replayOffset;
        }
      }
    }
  }
  // A replay cursor that does not advance strands every older transcript record.
  return Math.max(params.offset + 1, recordOffset);
}

function resolveChatHistoryActiveLeafEntryId(
  readPage: ReadRecentSessionMessagesResult,
): string | null {
  if (readPage.transcriptSource !== "active") {
    return null;
  }
  if (Object.hasOwn(readPage, "activeLeafEntryId")) {
    return readPage.activeLeafEntryId ?? null;
  }
  return resolveSessionTranscriptActiveLeafEntryId(readPage.transcriptEvents ?? []) ?? null;
}

/** Add checkpoint token metrics to the synthetic transcript compaction marker. */
export function enrichChatHistoryCompactionMarkers(
  messages: unknown[],
  entry: ChatHistoryPageParams["entry"],
): unknown[] {
  const checkpoints = entry?.compactionCheckpoints;
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return messages;
  }
  const checkpointByEntryId = new Map(
    checkpoints.flatMap((checkpoint) => {
      const entryId = checkpoint.postCompaction?.entryId;
      return typeof entryId === "string" && entryId ? [[entryId, checkpoint] as const] : [];
    }),
  );
  let changed = false;
  const enriched = messages.map((message) => {
    const record = asOptionalRecord(message);
    const metadata = asOptionalRecord(record?.["__openclaw"]);
    if (metadata?.kind !== "compaction" || typeof metadata.id !== "string") {
      return message;
    }
    const checkpoint = checkpointByEntryId.get(metadata.id);
    if (!checkpoint) {
      return message;
    }
    const tokensBefore = checkpoint.tokensBefore;
    const tokensAfter = checkpoint.tokensAfter;
    if (
      (typeof tokensBefore !== "number" || !Number.isFinite(tokensBefore)) &&
      (typeof tokensAfter !== "number" || !Number.isFinite(tokensAfter))
    ) {
      return message;
    }
    changed = true;
    return {
      ...record,
      __openclaw: {
        ...metadata,
        ...(typeof tokensBefore === "number" && Number.isFinite(tokensBefore)
          ? { tokensBefore }
          : {}),
        ...(typeof tokensAfter === "number" && Number.isFinite(tokensAfter) ? { tokensAfter } : {}),
      },
    };
  });
  return changed ? enriched : messages;
}

function resolveChatHistoryMessageGroup(
  messages: unknown[],
  index: number,
  messageCost: (message: unknown) => number,
): { start: number; end: number; cost: number } {
  const seq = readChatHistoryMessageSeq(messages[index]);
  let start = index;
  let end = index + 1;
  let cost = messageCost(messages[index]);
  if (seq === undefined) {
    return { start, end, cost };
  }
  while (start > 0 && readChatHistoryMessageSeq(messages[start - 1]) === seq) {
    start -= 1;
    cost += messageCost(messages[start]);
  }
  while (end < messages.length && readChatHistoryMessageSeq(messages[end]) === seq) {
    cost += messageCost(messages[end]);
    end += 1;
  }
  return { start, end, cost };
}

export function capChatHistoryAroundMessage(params: {
  messages: unknown[];
  messageId: string;
  maxCost: number;
  messageCost?: (message: unknown) => number;
}): unknown[] {
  const anchorIndex = params.messages.findIndex(
    (message) => readChatHistoryMessageId(message) === params.messageId,
  );
  if (anchorIndex === -1) {
    return [];
  }
  const messageCost = params.messageCost ?? (() => 1);
  const anchorGroup = resolveChatHistoryMessageGroup(params.messages, anchorIndex, messageCost);
  if (!(anchorGroup.cost <= params.maxCost)) {
    return [params.messages[anchorIndex]];
  }

  let { start, end, cost } = anchorGroup;
  let canGrowOlder = start > 0;
  let canGrowNewer = end < params.messages.length;
  while (canGrowOlder || canGrowNewer) {
    if (canGrowOlder) {
      const olderGroup = resolveChatHistoryMessageGroup(params.messages, start - 1, messageCost);
      if (cost + olderGroup.cost <= params.maxCost) {
        start = olderGroup.start;
        cost += olderGroup.cost;
      } else {
        canGrowOlder = false;
      }
    }
    canGrowOlder &&= start > 0;

    if (canGrowNewer) {
      const newerGroup = resolveChatHistoryMessageGroup(params.messages, end, messageCost);
      if (cost + newerGroup.cost <= params.maxCost) {
        end = newerGroup.end;
        cost += newerGroup.cost;
      } else {
        canGrowNewer = false;
      }
    }
    canGrowNewer &&= end < params.messages.length;
  }
  return params.messages.slice(start, end);
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
    return readChatHistoryPageLocal(params);
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
    messages: page.messages.map((message) => {
      const record = asOptionalRecord(message);
      return record ? project(record) : message;
    }),
  };
}

/** One page kernel is shared by process-memory reads and the transcript worker. */
export async function readChatHistoryPageLocal(
  params: ChatHistoryPageParams,
  options: { readOnly?: boolean; deferProfileDisplay?: boolean } = {},
): Promise<ChatHistoryPage> {
  const {
    entry,
    provider,
    sessionId,
    storePath,
    sessionAgentId,
    canonicalKey,
    max,
    maxHistoryBytes,
    effectiveMaxChars,
    offset,
    messageId,
  } = params;
  if (!sessionId || !storePath) {
    if (messageId) {
      return { messages: [] };
    }
    return {
      ...((offset ?? 0) === 0 ? { activeLeafEntryId: null } : {}),
      messages: [],
      ...(offset !== undefined ? { responseOffset: offset } : {}),
      pagination: { offset: offset ?? 0, totalMessages: 0, rawPageMessages: 0 },
    };
  }

  const readScope = {
    agentId: sessionAgentId,
    sessionEntry: entry,
    sessionId,
    sessionKey: canonicalKey,
    storePath,
  };
  const cliSessionId = params.ignoreCliSessionImports
    ? undefined
    : getCliSessionBinding(entry, "claude-cli")?.sessionId;
  // Bound snapshots are terminal by contract, so offset requests return the same
  // full snapshot. Paging oversized imports needs an opaque snapshot cursor and
  // is deferred to a follow-up issue. Anchored reads fall through with them: the
  // full-snapshot merge below still centers on messageId at the handler cap.
  if ((offset !== undefined || messageId) && !cliSessionId) {
    let pageOffset = offset ?? 0;
    let hasOverreadContext = false;
    let readPage: ReadRecentSessionMessagesResult;
    let incrementalTail: IncrementalChatHistoryTail | undefined;
    if (messageId) {
      const anchoredPage = await readSessionMessagesAroundIdWithStatsAsync(readScope, {
        messageId,
        maxMessages: max,
        allowResetArchiveFallback: true,
        readOnly: options.readOnly,
      });
      if (!anchoredPage.found) {
        return { messages: [] };
      }
      pageOffset = anchoredPage.offset;
      hasOverreadContext = anchoredPage.hasOverreadContext;
      readPage = anchoredPage;
    } else {
      incrementalTail = await readIncrementalChatHistoryTail({
        entry,
        readScope,
        effectiveMaxChars,
        max,
        maxBytes: maxHistoryBytes,
        offset: pageOffset,
        ...options,
      });
      readPage = incrementalTail.readPage;
    }
    const isTailPage = !messageId && pageOffset === 0;
    const overreadContextMessage = incrementalTail
      ? incrementalTail.overreadContextMessage
      : hasOverreadContext || readPage.messages.length > max
        ? readPage.messages[0]
        : undefined;
    const localMessages = incrementalTail
      ? incrementalTail.rawMessages
      : dropChatHistoryOverreadContextMessage(
          dropPreSessionStartAnnouncePairs(
            readPage.messages,
            typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
          ),
          overreadContextMessage,
        );
    const rawPageMessages = incrementalTail
      ? incrementalTail.rawPageMessages
      : Math.min(
          max,
          Math.max(readPage.messages.length, readPage.totalMessages > pageOffset ? 1 : 0),
        );
    const project = (messages: unknown[]) =>
      projectChatDisplayMessagesWithState(messages, {
        includeCommentaryFallbacks: true,
        maxChars: effectiveMaxChars,
        ...(options.deferProfileDisplay ? {} : { resolveCurrentUserProfileDisplay }),
        turnBoundaryPending: isHeartbeatHistoryTurnBoundaryMessage(overreadContextMessage),
      });
    const projection = incrementalTail?.projection ?? project(localMessages);
    let projected = incrementalTail?.projected ?? projection.messages;
    const newestPageSeq = readChatHistoryMessageSeq(localMessages.at(-1));
    if (
      !incrementalTail &&
      pageOffset > 0 &&
      newestPageSeq !== undefined &&
      projection.assistantErrorPending
    ) {
      const recoveryContext = await readChatHistoryRecoveryContext({
        messages: localMessages,
        createRecovery: (messages) => {
          const recovery = createChatHistoryRecoveryProjection({ maxChars: effectiveMaxChars });
          recovery.append(messages);
          return recovery;
        },
        readScope,
        displaySource: readPage.displaySource,
        maxBytes: maxHistoryBytes,
        readOnly: options.readOnly,
      });
      if (recoveryContext.length > 0) {
        projected = project([...localMessages, ...recoveryContext]).messages.filter(
          (message) => (readChatHistoryMessageSeq(message) ?? Infinity) <= newestPageSeq,
        );
      }
    }
    const windowed = messageId
      ? capChatHistoryAroundMessage({
          messages: projected,
          messageId,
          maxCost: max,
        })
      : projected;
    if (messageId) {
      // Numeric offsets do not encode the selected historical transcript source.
      return { messages: augmentChatHistoryWithCanvasBlocks(windowed) };
    }
    return {
      ...(isTailPage
        ? {
            activeLeafEntryId: resolveChatHistoryActiveLeafEntryId(readPage),
            ...(readPage.transcriptSource === "active" &&
            readPage.deltaCursor &&
            !incrementalTail?.projection.assistantErrorPending
              ? { deltaCursor: readPage.deltaCursor }
              : {}),
          }
        : {}),
      messages: augmentChatHistoryWithCanvasBlocks(windowed),
      responseOffset: pageOffset,
      pagination: {
        offset: pageOffset,
        totalMessages: readPage.totalMessages,
        rawPageMessages,
      },
    };
  }

  const incrementalTail = await readIncrementalChatHistoryTail({
    entry,
    readScope,
    effectiveMaxChars,
    max,
    maxBytes: maxHistoryBytes,
    offset,
    ...options,
  });
  const { readPage } = incrementalTail;
  const activeLeafEntryId = resolveChatHistoryActiveLeafEntryId(readPage);
  const localMessagesWithBoundaryFilter = incrementalTail.rawMessages;
  const buildTailPage = (messages: unknown[]): ChatHistoryPage => {
    const windowedTailMessages =
      offset === undefined
        ? messages.length > max
          ? messages.slice(-max)
          : messages
        : capOffsetChatHistoryProjectedMessages(messages, max);
    return {
      activeLeafEntryId,
      ...(readPage.transcriptSource === "active" &&
      readPage.deltaCursor &&
      !incrementalTail.projection.assistantErrorPending
        ? { deltaCursor: readPage.deltaCursor }
        : {}),
      messages: augmentChatHistoryWithCanvasBlocks(windowedTailMessages),
      pagination: {
        offset: offset ?? 0,
        totalMessages: readPage.totalMessages,
        rawPageMessages: incrementalTail.rawPageMessages,
      },
    };
  };
  if (!cliSessionId) {
    return buildTailPage(incrementalTail.projected);
  }
  const { readChatHistoryCliSessionImportSnapshot, resolveChatHistoryWithCliSessionImports } =
    await import("../cli-session-history.js");
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
    return readChatHistoryPageLocal({ ...params, ignoreCliSessionImports: true }, options);
  }
  if (cliHistory.expanded || messageId) {
    // Reuse this request's redacted external snapshot after the full local read;
    // re-reading here would duplicate a large import and defeat cross-client singleflight.
    const completeLocalMessages = dropPreSessionStartAnnouncePairs(
      await readSessionMessagesAsync(readScope, {
        mode: "full",
        reason: "chat.history CLI import merge",
        allowResetArchiveFallback: true,
        readOnly: options.readOnly,
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
      return readChatHistoryPageLocal({ ...params, ignoreCliSessionImports: true }, options);
    }
    const mergedMessages = dropPreSessionStartAnnouncePairs(
      completeCliHistory.messages,
      typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined,
    );
    const displayMessages = projectChatDisplayMessages(mergedMessages, {
      includeCommentaryFallbacks: true,
      maxChars: effectiveMaxChars,
      ...(options.deferProfileDisplay ? {} : { resolveCurrentUserProfileDisplay }),
    });
    if (!completeCliHistory.expanded && !messageId) {
      // A tail-only merge can look expanded because older imported rows are absent
      // from that local window. Preserve normal local pagination after the full merge
      // proves that the import only contributes identity metadata.
      const localPage = await readChatHistoryPageLocal(
        { ...params, ignoreCliSessionImports: true },
        options,
      );
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
}

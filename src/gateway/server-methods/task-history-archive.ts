import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { TasksHistoryResult } from "../../../packages/gateway-protocol/src/index.js";
import { composeTranscriptDisplay } from "../../chat/transcript-display-position.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  readSessionTaskArchivePageReadOnly,
  verifySessionTranscriptArchivePageBindingReadOnly,
} from "../../config/sessions/session-history.js";
import { captureSessionTranscriptStorageEnvironment } from "../../config/sessions/transcript-target-binding.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { projectChatDisplayMessagesWithState } from "../chat-display-projection.core.js";
import { resolveEffectiveChatHistoryMaxChars } from "../chat-display-projection.js";
import { prepareSessionHistorySubagentSources } from "../session-history-subagent-projection.js";
import {
  readChatHistoryMessageSeq,
  SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES,
} from "../session-history-tail.js";
import { projectTranscriptEntryMessage } from "../session-transcript-entry-message.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  buildChatHistoryUnavailableSentinel,
  createChatHistoryActivityProjection,
  createChatHistoryByteCounter,
  replaceOversizedChatHistoryMessages,
} from "./chat-history-budget.js";

/** Archived tasks use the same message and activity projection as live chat history. */
export async function readArchivedTaskHistory(params: {
  scope: Parameters<typeof readSessionTaskArchivePageReadOnly>[0];
  runId: string;
  cursor?: string;
  limit: number;
  maxBytes: number;
  assertCurrent: () => void;
}): Promise<TasksHistoryResult | undefined> {
  const databaseOptions = toDatabaseOptions(resolveSqliteReadScope(params.scope));
  const sources = prepareSessionHistorySubagentSources(
    { agentId: databaseOptions.agentId, path: resolveOpenClawAgentSqlitePath(databaseOptions) },
    { env: captureSessionTranscriptStorageEnvironment(params.scope.env ?? process.env) },
  );
  const assertCurrent = () => {
    sources.assertCurrent();
    params.assertCurrent();
  };
  let limit = params.limit;
  for (;;) {
    assertCurrent();
    const page = await readSessionTaskArchivePageReadOnly(params.scope, {
      runId: params.runId,
      cursor: params.cursor,
      limit,
      maxBytes: params.maxBytes,
      contextMaxMessages: SILENT_CHAT_HISTORY_TAIL_SCAN_MAX_MESSAGES,
      projectionSources: {
        stateDatabase: sources.stateDatabase,
        sourceDatabases: sources.sourceDatabases,
      },
    });
    assertCurrent();
    if (!page) {
      return undefined;
    }
    const selectedSeqs = new Set(page.entries.map(({ seq }) => seq));
    const projection = projectChatDisplayMessagesWithState(
      [...page.entries, ...(page.contextEntries ?? [])]
        .toSorted((left, right) => left.seq - right.seq)
        .map(({ event, seq, coordinationHidden }) => {
          const message = projectTranscriptEntryMessage(event, seq);
          const record = asOptionalRecord(message);
          if (coordinationHidden && record) {
            record.display = false;
          }
          return message;
        })
        .filter(Boolean),
      {
        includeCommentaryFallbacks: true,
        maxChars: resolveEffectiveChatHistoryMaxChars(undefined),
      },
    );
    const selectedMessages = projection.messages.filter((message) =>
      selectedSeqs.has(readChatHistoryMessageSeq(message) ?? -1),
    );
    const activity = createChatHistoryActivityProjection(selectedMessages, projection.activity);
    const messages = replaceOversizedChatHistoryMessages({
      byteCounter: createChatHistoryByteCounter(activity),
      messages: selectedMessages,
      maxSingleMessageBytes: CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
    }).messages;
    const result: TasksHistoryResult = {
      messages: page.omittedOversized
        ? [buildChatHistoryUnavailableSentinel()]
        : composeTranscriptDisplay(messages),
      ...(messages.some((message) => activity.has(message))
        ? { activity: messages.flatMap((message) => activity.get(message) ?? []) }
        : {}),
      ...(page.nextCursor ? { nextCursor: `archive:${page.nextCursor}` } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > params.maxBytes) {
      if (page.entries.length <= 1) {
        result.messages = [buildChatHistoryUnavailableSentinel()];
        delete result.activity;
      } else {
        // Only the archive owner can regenerate its generation-bound cursor. Halving
        // the actual source count takes at most eight adjustments for the RPC limit.
        limit = Math.floor(page.entries.length / 2);
        continue;
      }
    }
    await verifySessionTranscriptArchivePageBindingReadOnly(
      params.scope,
      params.runId,
      page.binding,
    );
    assertCurrent();
    return result;
  }
}

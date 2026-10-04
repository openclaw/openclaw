import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
// Claude's native transcript augments display history, never canonical model context.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { withTranscriptRedactionSnapshot } from "../agents/transcript-redact-text.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
  ChatHistoryMessageParams,
} from "../config/sessions/session-history-types.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import {
  resolveHistoryAnchorPageRange,
  resolveTranscriptPageEnd,
} from "../sessions/transcript-anchor-page.js";
import type { TranscriptReadWindow } from "../sessions/transcript-read-window.js";
import {
  dropPreSessionStartAnnouncePairs,
  isPreSessionStartAssistantMessage,
} from "./chat-display-projection.history.js";
import { CliSessionHistoryIndex } from "./cli-session-history-index.worker.js";
import {
  resolveClaudeCliHistorySource,
  visitClaudeCliSessionMessages,
} from "./cli-session-history.claude-snapshot.js";
import {
  readChatHistoryMessageId,
  readChatHistoryMessageSeq,
  readChatHistoryPaginationKey,
  readIncrementalChatHistoryTail,
} from "./session-history-tail.js";
import { filterSessionMessageHistoryVisibility } from "./session-transcript-read-kernel.js";
import type {
  ReadSessionMessageByIdResult,
  SessionTranscriptPageOptions,
  SessionTranscriptPageReader,
} from "./session-transcript-read.types.js";

export type CliHistoryRevision = {
  database: DatabaseSync;
  generation?: string;
  indexedSeq: number;
  leafEventId: string | null;
};
export type CliHistoryReaders = SessionTranscriptPageReader & {
  assertNativeHistoryAuthorized?: () => Promise<void>;
  // Durable cache admission supplies a revision; uncached process-held reads use page fences.
  readHistoryRevision?: () => CliHistoryRevision | Promise<CliHistoryRevision>;
};
type Readers = CliHistoryReaders;
type CachedIndex = {
  database?: DatabaseSync;
  key: string;
  index: CliSessionHistoryIndex;
  release: () => void;
  readWindow?: TranscriptReadWindow;
  displaySource?: string;
  leafEventId: string | null;
};
const indexes = new Map<string, CachedIndex>();
const MAX_INDEXES = 8;

function retire(identity: string): void {
  const cached = indexes.get(identity);
  if (!cached) {
    return;
  }
  indexes.delete(identity);
  cached.release();
  cached.index.close();
}

/** Only this worker owns derived native history; requests receive selected rows. */
export async function prepareCliSessionHistoryReader(
  params: ChatHistoryPageParams,
  readers: Readers,
) {
  if (params.ignoreCliSessionImports) {
    return undefined;
  }
  if (
    params.entry?.execHost === "node" ||
    !params.cliHistoryProjectsRoot ||
    !path.isAbsolute(params.cliHistoryProjectsRoot)
  ) {
    return undefined;
  }
  const binding = getCliSessionBinding(params.entry, "claude-cli");
  if (!binding?.sessionId || !params.sessionId || !params.storePath) {
    return undefined;
  }
  const readRevision = readers.readHistoryRevision;
  const revision = await readRevision?.();
  const scope = {
    agentId: params.sessionAgentId,
    sessionId: params.sessionId,
    sessionKey: params.canonicalKey,
    storePath: params.storePath,
    sessionEntry: params.entry,
  };
  const provider = normalizeProviderId(params.provider ?? "");
  if (provider && provider !== "claude-cli" && provider !== "anthropic") {
    const tail = await readIncrementalChatHistoryTail({
      entry: params.entry,
      readScope: scope,
      readers,
      effectiveMaxChars: params.effectiveMaxChars,
      max: params.max,
      maxBytes: params.maxHistoryBytes,
      offset: params.offset,
      readOnly: true,
      deferProfileDisplay: true,
    });
    if (tail.rawMessages.length) {
      return undefined;
    }
  }
  const redaction = params.cliHistoryRedaction;
  if (!redaction) {
    throw new Error("CLI history requires prepared transcript redaction");
  }
  const native = {
    cliSessionId: binding.sessionId,
    homeDir: params.cliHistoryHomeDir,
    cwd: binding.cwd ?? params.cwd,
    projectsRoot: params.cliHistoryProjectsRoot,
    localSessionId: params.sessionId,
    reseedReceipt: binding.reseedReceipt,
    assertNativeHistoryAuthorized: readers.assertNativeHistoryAuthorized,
  };
  const identity = JSON.stringify([params.storePath, params.sessionAgentId, params.sessionId]);
  await readers.assertNativeHistoryAuthorized?.();
  const source = await resolveClaudeCliHistorySource(native);
  if (!source) {
    retire(identity);
    return undefined;
  }
  const revisionKey = (value: CliHistoryRevision) =>
    JSON.stringify([value.generation, value.indexedSeq, value.leafEventId]);
  const localRevision = revision ? revisionKey(revision) : undefined;
  const key = JSON.stringify([
    localRevision,
    source[1],
    params.cliHistoryProjectsRoot,
    params.entry?.sessionStartedAt,
    redaction.policyToken,
  ]);
  let cached = revision?.database ? indexes.get(identity) : undefined;
  if (cached && (cached.database !== revision?.database || cached.key !== key)) {
    retire(identity);
    cached = undefined;
  }
  const assertCurrent = async () => {
    if (!revision || !readRevision) {
      return;
    }
    const current = await readRevision();
    if (current.database !== revision?.database || current.generation !== revision.generation) {
      if (revision?.database) {
        retire(identity);
      }
      throw new SessionTranscriptProjectionUnavailableError(params.sessionId!, "window-changed");
    }
  };
  if (!cached) {
    const index = new CliSessionHistoryIndex(!revision?.database);
    try {
      await withTranscriptRedactionSnapshot(redaction, () =>
        visitClaudeCliSessionMessages(
          source[0],
          native,
          (message) => index.appendImported(message),
          source[2],
        ),
      );
      if (!index.importedCount) {
        index.close();
        return undefined;
      }
      let beforeSeq: number | undefined;
      let readWindow: TranscriptReadWindow | undefined;
      let displaySource: string | undefined;
      let activeSource = false;
      let leafEventId = revision?.leafEventId ?? null;
      let boundaryMessage: unknown;
      const localRow = (message: unknown) => {
        const seq = readChatHistoryMessageSeq(message);
        if (seq === undefined) {
          throw new Error("Indexed CLI history requires a canonical source sequence");
        }
        return { message, seq };
      };
      for (;;) {
        const page = await readers.readSessionMessagesPageWithStatsAsync(scope, {
          offset: 0,
          beforeSeq,
          maxMessages: 65,
          maxBytes: 1024 * 1024,
          allowOversizedFirst: true,
          allowResetArchiveFallback: true,
          readOnly: true,
          captureReadWindow: beforeSeq === undefined,
          expectedReadWindow: readWindow,
        });
        await assertCurrent();
        if (page.windowReset) {
          throw new SessionTranscriptProjectionUnavailableError(params.sessionId, "window-changed");
        }
        if (beforeSeq === undefined) {
          readWindow = page.readWindow;
          displaySource = page.displaySource;
          activeSource = page.transcriptSource === "active";
          leafEventId = page.activeLeafEntryId ?? null;
        } else if (page.displaySource !== displaySource) {
          throw new SessionTranscriptProjectionUnavailableError(params.sessionId, "window-changed");
        }
        if (!page.messages.length) {
          break;
        }
        // A preceding announce may live in the next older chunk. Defer one boundary row.
        const oldestMessage = page.messages[0];
        const filtered = dropPreSessionStartAnnouncePairs(
          boundaryMessage === undefined ? page.messages : [...page.messages, boundaryMessage],
          params.entry?.sessionStartedAt,
        );
        index.appendLocal(filtered.filter((message) => message !== oldestMessage).map(localRow));
        boundaryMessage = filtered.includes(oldestMessage) ? oldestMessage : undefined;
        const oldest = readChatHistoryMessageSeq(page.messages[0]);
        if (oldest === undefined || oldest <= 1) {
          break;
        }
        if (beforeSeq !== undefined && oldest >= beforeSeq) {
          throw new Error("CLI history index did not advance");
        }
        beforeSeq = oldest;
        await yieldToEventLoop();
      }
      if (boundaryMessage !== undefined) {
        index.appendLocal([localRow(boundaryMessage)]);
      }
      const currentSource = await resolveClaudeCliHistorySource(native);
      await assertCurrent();
      index.finish();
      if (activeSource && revision?.database && currentSource?.[1] === source[1]) {
        cached = {
          database: revision?.database,
          key,
          index,
          readWindow,
          displaySource,
          leafEventId,
          release: registerNodeSqliteDisposeCallback(revision?.database, () => retire(identity)),
        };
        indexes.set(identity, cached);
        while (indexes.size > MAX_INDEXES) {
          retire(indexes.keys().next().value!);
        }
      } else {
        cached = { key, index, readWindow, displaySource, leafEventId, release: () => {} };
      }
    } catch (error) {
      index.close();
      throw error;
    }
  }
  // Refresh LRU only after a completed admission.
  if (cached.database) {
    indexes.delete(identity);
    indexes.set(identity, cached);
  }
  const index = cached.index;
  const sequence = (message: unknown) => {
    const id = readChatHistoryMessageId(message);
    const seq = readChatHistoryMessageSeq(message);
    const ordinal = id
      ? index.ordinal(id)
      : seq === undefined
        ? undefined
        : index.localOrdinal(seq);
    return ordinal === undefined ? undefined : ordinal + 1;
  };
  const readRange = async (start: number, end: number, maxBytes = Number.POSITIVE_INFINITY) => {
    const selected = index.rows(start, end);
    let bytes = 0;
    let first = selected.length;
    while (
      first > 0 &&
      (first === selected.length || bytes + selected[first - 1]!.bytes <= maxBytes)
    ) {
      bytes += selected[--first]!.bytes;
    }
    const window = selected.slice(first);
    const ranges: Array<{ start: number; end: number; bytes: number }> = [];
    for (const row of window
      .filter((candidate) => candidate.local_seq !== null)
      .toSorted((a, b) => a.local_seq! - b.local_seq!)) {
      const seq = row.local_seq!;
      const prior = ranges.at(-1);
      if (prior && prior.end + 1 === seq && prior.end - prior.start < 64) {
        prior.end = seq;
        prior.bytes += row.bytes;
      } else {
        ranges.push({ start: seq, end: seq, bytes: row.bytes });
      }
    }
    const localMessages = new Map<number, unknown>();
    for (const range of ranges) {
      const localPage = await readers.readSessionMessagesPageWithStatsAsync(scope, {
        offset: 0,
        beforeSeq: range.end + 1,
        maxMessages: range.end - range.start + 1,
        maxBytes: range.bytes + 1024 * 1024,
        allowOversizedFirst: true,
        allowResetArchiveFallback: true,
        readOnly: true,
        expectedReadWindow: cached.readWindow,
      });
      await assertCurrent();
      if (localPage.windowReset || localPage.displaySource !== cached.displaySource) {
        throw new SessionTranscriptProjectionUnavailableError(params.sessionId!, "window-changed");
      }
      for (const message of localPage.messages) {
        const seq = readChatHistoryMessageSeq(message);
        if (seq !== undefined) {
          localMessages.set(seq, message);
        }
      }
    }
    const messages: unknown[] = [];
    for (const row of window) {
      const message =
        row.local_seq === null ? index.message(row.id) : localMessages.get(row.local_seq);
      const record = asOptionalRecord(message);
      if (!record) {
        throw new SessionTranscriptProjectionUnavailableError(params.sessionId!, "window-changed");
      }
      messages.push({
        ...record,
        ...(row.metadata ? { __openclaw: JSON.parse(row.metadata) } : {}),
      });
    }
    await assertCurrent();
    return messages;
  };
  const page = async (options: SessionTranscriptPageOptions) => {
    const end = resolveTranscriptPageEnd(index.count, options);
    const start = Math.max(0, end - Math.max(1, options.maxMessages));
    return {
      messages: await readRange(start, end, options.maxBytes),
      totalMessages: index.count,
      activeLeafEntryId: cached.leafEventId,
      transcriptSource: "active" as const,
      displaySource: key,
      readWindow: { source: key, latestResetRawSeq: null },
    };
  };
  const readIndexedMessage: Readers["readSessionMessageByIdAsync"] = async (
    readScope,
    messageId,
    options,
  ) => {
    const ordinal = index.ordinal(messageId);
    if (ordinal === undefined) {
      return { found: false, oversized: false };
    }
    const [message] = await readRange(ordinal, ordinal + 1, options?.maxBytes);
    const precedingMessage =
      options?.historyVisibility &&
      ordinal > 0 &&
      isPreSessionStartAssistantMessage(message, options.historyVisibility.sessionStartedAt)
        ? (await readRange(ordinal - 1, ordinal))[0]
        : undefined;
    return filterSessionMessageHistoryVisibility(
      {
        found: message !== undefined,
        oversized: false,
        message,
        seq: ordinal + 1,
        historyContext: { displaySource: key, precedingMessage },
      },
      readScope,
      messageId,
      options?.historyVisibility,
      prepared.readers,
    );
  };
  const prepared = {
    readIndexedMessage,
    dispose: () => {
      if (!cached.database) {
        index.close();
      }
    },
    sequence,
    applyPagination(historyPage: ChatHistoryPage) {
      if (historyPage.pagination) {
        historyPage.pagination.messageSequences = Object.fromEntries(
          historyPage.messages.flatMap((message) => {
            const id = readChatHistoryPaginationKey(message);
            const seq = sequence(message);
            return id && seq !== undefined ? [[id, seq]] : [];
          }),
        );
      }
    },
    readers: {
      ...readers,
      readRecentSessionMessagesWithStatsAsync: async (
        _scope: Parameters<Readers["readSessionMessagesPageWithStatsAsync"]>[0],
        options: Parameters<Readers["readRecentSessionMessagesWithStatsAsync"]>[1],
      ) => page({ ...options, offset: 0 }),
      readSessionMessagesPageWithStatsAsync: async (
        _scope: Parameters<Readers["readSessionMessagesPageWithStatsAsync"]>[0],
        options: SessionTranscriptPageOptions,
      ) => page(options),
      readSessionMessagesAroundIdWithStatsAsync: async (
        _scope: Parameters<Readers["readSessionMessagesPageWithStatsAsync"]>[0],
        options: Parameters<Readers["readSessionMessagesAroundIdWithStatsAsync"]>[1],
      ) => {
        const ordinal = index.ordinal(options.messageId);
        const range =
          ordinal === undefined
            ? undefined
            : resolveHistoryAnchorPageRange(index.count, ordinal, options);
        return {
          messages: range
            ? await readRange(range.readStart, range.endExclusive, options.maxBytes)
            : [],
          totalMessages: index.count,
          found: Boolean(range),
          offset: range?.offset ?? 0,
          hasOverreadContext: range?.hasOverreadContext ?? false,
          displaySource: key,
        };
      },
    },
  };
  prepared.readers.readSessionMessageByIdAsync = (...args) =>
    readCanonicalOrImportedMessage(readers, args, () => readIndexedMessage(...args));
  return prepared;
}

async function readCanonicalOrImportedMessage(
  readers: Readers,
  args: Parameters<Readers["readSessionMessageByIdAsync"]>,
  readImported: (missing: ReadSessionMessageByIdResult) => Promise<ReadSessionMessageByIdResult>,
): Promise<ReadSessionMessageByIdResult> {
  const local = await readers.readSessionMessageByIdAsync(...args);
  return local.found || local.historyHidden ? local : readImported(local);
}

/** Canonical IDs retain archive access; imported-only IDs use the page owner's admitted index. */
export async function readChatHistoryMessageFromReaders(
  params: ChatHistoryMessageParams,
  readers: CliHistoryReaders,
): Promise<ReadSessionMessageByIdResult> {
  const scope = {
    agentId: params.sessionAgentId,
    sessionId: params.sessionId,
    sessionKey: params.canonicalKey,
    storePath: params.storePath,
    sessionEntry: params.entry,
  };
  const options = {
    allowResetArchiveFallback: true,
    historyVisibility: { sessionStartedAt: params.entry?.sessionStartedAt },
  };
  return readCanonicalOrImportedMessage(
    readers,
    [scope, params.messageId, options],
    async (missing) => {
      const cli = await prepareCliSessionHistoryReader(params, readers);
      try {
        return cli ? await cli.readIndexedMessage(scope, params.messageId, options) : missing;
      } finally {
        cli?.dispose();
      }
    },
  );
}

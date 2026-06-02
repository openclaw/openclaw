import {
  buildInboundHistoryFromMap,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
  recordPendingHistoryEntryWithMedia,
} from "../../auto-reply/reply/history.js";
import type { HistoryEntry, HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";

type MaybePromise<T> = T | Promise<T>;

/** Windowed channel history facade used by turn adapters to record and render recent context. */
export type ChannelHistoryWindow<T extends HistoryEntry = HistoryEntry> = {
  /** Append a text history entry and return the bounded window. */
  record: (params: { historyKey: string; entry?: T | null; limit: number }) => T[];
  /** Append a history entry that may resolve media lazily before recording. */
  recordWithMedia: (params: {
    historyKey: string;
    entry?: T | null;
    limit: number;
    media?:
      | readonly HistoryMediaEntry[]
      | null
      | (() => MaybePromise<readonly HistoryMediaEntry[] | null | undefined>);
    mediaLimit?: number;
    messageId?: string;
    shouldRecord?: () => boolean;
  }) => Promise<T[]>;
  /** Render pending history around the current inbound message. */
  buildPendingContext: (params: {
    historyKey: string;
    limit: number;
    currentMessage: string;
    formatEntry: (entry: T) => string;
    lineBreak?: string;
  }) => string;
  /** Return the bounded inbound history payload for agent context. */
  buildInboundHistory: (params: {
    historyKey: string;
    limit: number;
  }) => HistoryEntry[] | undefined;
  /** Trim or clear the caller-owned history window for one key. */
  clear: (params: { historyKey: string; limit: number }) => void;
};

/** Creates a bounded channel history window over a caller-owned history map. */
export function createChannelHistoryWindow<T extends HistoryEntry = HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
}): ChannelHistoryWindow<T> {
  const { historyMap } = params;
  return {
    record: (recordParams) =>
      recordPendingHistoryEntryIfEnabled({
        historyMap,
        historyKey: recordParams.historyKey,
        limit: recordParams.limit,
        entry: recordParams.entry,
      }),
    recordWithMedia: (recordParams) =>
      recordPendingHistoryEntryWithMedia({
        historyMap,
        historyKey: recordParams.historyKey,
        limit: recordParams.limit,
        entry: recordParams.entry,
        media: recordParams.media,
        mediaLimit: recordParams.mediaLimit,
        messageId: recordParams.messageId,
        shouldRecord: recordParams.shouldRecord,
      }),
    buildPendingContext: (contextParams) =>
      buildPendingHistoryContextFromMap({
        historyMap,
        historyKey: contextParams.historyKey,
        limit: contextParams.limit,
        currentMessage: contextParams.currentMessage,
        // The shared renderer is HistoryEntry-based; this facade keeps adapter-specific entry
        // subtypes local while handing the renderer the common fields it actually consumes.
        formatEntry: contextParams.formatEntry as (entry: HistoryEntry) => string,
        lineBreak: contextParams.lineBreak,
      }),
    buildInboundHistory: (historyParams) =>
      buildInboundHistoryFromMap({
        historyMap,
        historyKey: historyParams.historyKey,
        limit: historyParams.limit,
      }),
    clear: (clearParams) =>
      clearHistoryEntriesIfEnabled({
        historyMap,
        historyKey: clearParams.historyKey,
        limit: clearParams.limit,
      }),
  };
}

// Windowed channel history facade over caller-owned pending-history maps.
import {
  buildChannelInboundHistory,
  buildChannelPendingHistoryContext,
  clearChannelHistoryIfEnabled,
  recordChannelHistoryEntryIfEnabled,
  recordChannelHistoryEntryWithMedia,
} from "../../auto-reply/reply/history.js";
import type { HistoryEntry } from "../../auto-reply/reply/history.types.js";

/** Windowed channel history facade used by turn adapters to record and render recent context. */
export type ChannelHistoryWindow<T extends HistoryEntry = HistoryEntry> = {
  record: (params: { historyKey: string; entry?: T | null; limit: number }) => T[];
  recordWithMedia: (
    params: Omit<Parameters<typeof recordChannelHistoryEntryWithMedia<T>>[0], "historyMap">,
  ) => Promise<T[]>;
  buildPendingContext: (params: {
    historyKey: string;
    limit: number;
    currentMessage: string;
    formatEntry: (entry: T) => string;
    lineBreak?: string;
  }) => string;
  buildInboundHistory: (params: {
    historyKey: string;
    limit: number;
  }) => HistoryEntry[] | undefined;
  clear: (params: { historyKey: string; limit: number }) => void;
};

/** Creates a bounded channel history window over a caller-owned history map. */
export function createChannelHistoryWindow<T extends HistoryEntry = HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
}): ChannelHistoryWindow<T> {
  const { historyMap } = params;
  return {
    record: (recordParams) => recordChannelHistoryEntryIfEnabled({ ...recordParams, historyMap }),
    recordWithMedia: (recordParams) =>
      recordChannelHistoryEntryWithMedia({ ...recordParams, historyMap }),
    buildPendingContext: (contextParams) =>
      buildChannelPendingHistoryContext({
        ...contextParams,
        historyMap,
        formatEntry: contextParams.formatEntry as (entry: HistoryEntry) => string,
      }),
    buildInboundHistory: (historyParams) =>
      buildChannelInboundHistory({ ...historyParams, historyMap }),
    clear: (clearParams) => clearChannelHistoryIfEnabled({ ...clearParams, historyMap }),
  };
}

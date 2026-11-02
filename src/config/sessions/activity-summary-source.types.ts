import type { SessionActivitySummary } from "./activity-summary.js";

export type SessionActivitySummaryBatchInput = {
  scope: {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
    storePath?: string;
    env?: NodeJS.ProcessEnv;
  };
  previous?: SessionActivitySummary;
};

export type SessionActivitySummaryBatchResult =
  | {
      previous: SessionActivitySummary | undefined;
      snapshot: {
        totalMessages: number;
        activeLeafEntryId?: string | null;
        snapshot: { generation?: string };
      };
      watermark: { generation: string | null; maxSeq: number | null };
      covered: number;
      page: {
        events: { event: unknown }[];
        scannedMessages: number;
      };
      omitted: boolean;
    }
  | undefined;

import type { AgentMessage } from "../../agents/runtime/index.js";

export type SessionTranscriptUsageSnapshot = {
  promptTokens?: number;
  outputTokens?: number;
  trailingMessages: AgentMessage[];
};

export type SessionLogSnapshot = {
  byteSize?: number;
  eventCount?: number;
  turnTainted?: boolean;
  usage?: SessionTranscriptUsageSnapshot;
};

export type SessionLogSnapshotOptions = {
  includeByteSize: boolean;
  includeTurnTaint?: boolean;
  includeUsage: boolean;
  usageEventLimit?: number;
};

export const SQLITE_USAGE_TAIL_MAX_EVENTS = 512;

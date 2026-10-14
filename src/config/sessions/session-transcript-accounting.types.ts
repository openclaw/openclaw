import type { AgentMessage } from "../../../packages/agent-core/src/types.js";

export const SQLITE_USAGE_TAIL_MAX_EVENTS = 512;

export type SessionTranscriptAccountingOptions = {
  includeByteSize: boolean;
  includeTurnTaint?: boolean;
  includeUsage: boolean;
  usageEventLimit?: number;
};

export type SessionTranscriptUsageSnapshot = {
  promptTokens?: number;
  outputTokens?: number;
  trailingMessages: AgentMessage[];
};

export type SessionTranscriptAccountingSnapshot = {
  byteSize?: number;
  eventCount?: number;
  turnTainted?: boolean;
  usage?: SessionTranscriptUsageSnapshot;
};

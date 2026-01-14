import type { ChannelId } from "../channels/plugins/types.js";

export type SessionStatus = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  sessionId?: string;
  updatedAt: number | null;
  age: number | null;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number | null;
  remainingTokens: number | null;
  percentUsed: number | null;
  model: string | null;
  contextTokens: number | null;
  flags: string[];
};

export type StatusSummary = {
  linkChannel?: {
    id: ChannelId;
    label: string;
    linked: boolean;
    authAgeMs: number | null;
  };
  heartbeatSeconds: number;
  channelSummary: string[];
  queuedSystemEvents: string[];
  sessions: {
    path: string;
    count: number;
    defaults: { model: string | null; contextTokens: number | null };
    recent: SessionStatus[];
  };
};

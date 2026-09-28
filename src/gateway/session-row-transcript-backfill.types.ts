import type { InternalSessionEntry } from "../config/sessions/types.js";

export type SessionRowTranscriptReadParams = {
  agentId: string;
  storeAgentId?: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  sessionEntry: Pick<
    InternalSessionEntry,
    "sessionId" | "updatedAt" | "status" | "lastRunId" | "fallbackNotice"
  >;
  includeTerminalModel?: boolean;
};

export type SessionRowTranscriptFields = {
  lastMessagePreview?: string;
  terminalModel?: { modelProvider: string; model: string };
};

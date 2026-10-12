import type { SessionPendingInputRow } from "./session-pending-input.types.js";

export type PendingInputHistoryQuery = {
  sessionKey: string;
  sessionId: string;
  limit?: number;
  before?: number;
  id?: string;
};
export type PendingInputHistorySnapshot = {
  rows: SessionPendingInputRow[];
  total: number | undefined;
  nextBefore?: number;
  currentSessionId?: string;
};
export type PendingInputCustodyCandidate = Pick<
  SessionPendingInputRow,
  "input_id" | "session_key" | "session_id" | "lifecycle_generation"
>;
export type PendingInputHistoryGrant = {
  kind: "pending-input-history-custody";
  candidates: PendingInputCustodyCandidate[];
  currentSessionId?: string;
  protected?: SharedArrayBuffer;
};
export type PendingInputHistoryReceipt = {
  kind: "pending-input-history-interrupted";
  ids: string[];
};
export type PendingInputHistoryWorkerInput = {
  kind: "session-pending-input-history";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  query: PendingInputHistoryQuery;
  source: import("./session-entry-read-source.types.js").CapturedSessionEntryReadSource;
};

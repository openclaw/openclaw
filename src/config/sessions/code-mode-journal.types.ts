/** Persisted facts, never a capability to execute on behalf of the requester. */
export type CodeModeSourceAssertion = {
  version: 1;
  /** Serialized source-owner facts; recovery re-admits them. No tokens or secrets. */
  sourceJson: string;
};
export const CODE_MODE_JOURNAL_VERSION = 1;
export const CODE_MODE_JOURNAL_LIMITS = {
  // Four full records remain below the worker transport reply budget.
  executionsPerSession: 4,
  callsPerExecution: 256,
  recordBytes: 4 * 1024 * 1024,
  // Reserve two encoded JSON values plus envelope overhead for terminal settlement.
  activeRecordBytes: 2 * 1024 * 1024 - 1024,
  jsonValueBytes: 1024 * 1024,
} as const;
export type CodeModeJournalKey = {
  sessionKey: string;
  sessionId: string;
  executionId: string;
};
export type CodeModeJournalStart = CodeModeJournalKey & {
  version: 1;
  runId: string;
  toolCallId: string;
  source: CodeModeSourceAssertion;
  /** Source, seed, deadline, fingerprint, globals and initial store owned by the executor. */
  programJson: string;
};
export type CodeModeJournalCallIntent = {
  key: string;
  operationId: string;
  name: string;
  argsJson: string;
  /** Evidence only; the current tool owner must admit any retry. */
  recovery: "interrupt" | "safe" | "reconcile";
};
export type CodeModeJournalCall = CodeModeJournalCallIntent &
  (
    | { state: "pending" }
    | { state: "completed"; resultJson: string; deliveryIndex: number; issuedCalls: number }
  );
export type CodeModeJournal = CodeModeJournalStart & {
  calls: CodeModeJournalCall[];
  outcome?: {
    /** Exact final tool result; survives until authoritative transcript settlement. */
    resultJson: string;
    /** Executor-owned final store state commits with the result, not after it. */
    storeJson: string;
  };
};
export type CodeModeJournalCallCompletion = CodeModeJournalKey & {
  key: string;
  resultJson: string;
  /** Number of calls issued before releasing this result to the guest. */
  issuedCalls: number;
};

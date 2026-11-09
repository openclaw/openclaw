import type {
  OwnedWait,
  SessionWatchdogDecision,
  SessionWatchdogSnapshot,
} from "./session-controller.watchdog-state.js";

export type SessionWatchdogProgress = "semantic" | "transport" | "source_arrival" | "finalization";

export type SessionWatchdogWait = {
  close: () => void;
  updateDeadline(deadlineAtMs: number): void;
};
export type SessionControllerWatchdogAttempt = {
  isCurrent(): boolean;
  progress(kind: SessionWatchdogProgress, reason?: string): boolean;
  progressModel(reason?: string): boolean;
  observeStagnation(params: { active: boolean; existingOnly?: boolean }): void;
  progressTool(toolCallId: string, allowedNames: readonly string[]): boolean;
  beginWait(wait: OwnedWait): SessionWatchdogWait;
  beginTool(tool: {
    toolCallId: string;
    toolName: string;
    deadlineAtMs?: number;
  }): (completed?: boolean) => void;
  toolEvent(event: {
    phase: "start" | "end";
    toolCallId: string;
    toolName: string;
    deadlineAtMs?: number;
  }): void;
  beginRequest(params: {
    deadlineAtMs?: number;
    requestTimeoutMs?: number;
  }): (recoveryDeadlineAtMs?: number) => void;
  requestEvent(event: { phase: "start" | "end"; callId: string; requestTimeoutMs?: number }): void;
  setExecutionDeadline(deadlineAtMs: number | undefined): void;
  close(): void;
};
export type SessionWatchdogEffect = {
  cause: "run_stalled";
  reason: string;
  attempt?: SessionControllerWatchdogAttempt;
  /** Revalidate at each actual asynchronous stop/cleanup side effect. */
  isCurrent(): boolean;
  recoverExecutionDeadline?: () => Promise<boolean>;
};
export type SessionWatchdogEffectResult = "settled" | "blocked" | "resumed" | "model_recovery";
export type SessionControllerWatchdog = {
  start(): void;
  close(): void;
  snapshot(now?: number): SessionWatchdogSnapshot;
  decide(now?: number): SessionWatchdogDecision;
  tick(now?: number): Promise<SessionWatchdogDecision>;
  progress(kind: SessionWatchdogProgress, reason?: string): boolean;
  beginWait(wait: OwnedWait): SessionWatchdogWait;
  attachAttempt(params: {
    assertCurrent: () => void;
    /** Nested maintenance shares the current attempt's lifetime without replacing it. */
    nested?: boolean;
  }): SessionControllerWatchdogAttempt;
  describeStop(): { staleReason: "no_activity" | "rate_limited"; error: Error };
  beginFinalization(): void;
  beginTerminal(deadlineAtMs?: number): void;
  beginExecution(
    getDeadlineAtMs?: () => number | undefined,
    recoverDeadline?: () => Promise<boolean>,
  ): {
    setDeadline(deadlineAtMs: number | undefined): void;
    close(): void;
  };
  beginFinalizationWork(timeoutMs: number): () => void;
};

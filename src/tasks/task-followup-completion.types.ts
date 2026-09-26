import type { AgentWaitResult } from "../agents/run-wait.types.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { CreatedDetachedTaskRun } from "./detached-task-runtime-contract.js";
import type { TaskRunOwner } from "./task-run-owner.types.js";

export type FollowupReply = AgentWaitResult & { replyText?: string };
type FollowupCustody = {
  run<T>(work: () => T): T;
  assertCurrent(): void;
  signal: AbortSignal;
  release(): void;
};
export type FollowupRequest = {
  runId: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterAgentId: string;
  targetSessionKey: string;
  targetAgentId: string;
  custody: FollowupCustody;
  completion?: FollowupCompletionOwner;
};
export type FollowupCohort = { entries: readonly SubagentRunRecord[]; generation: number };
export type FollowupSuccessor = {
  owner: FollowupCompletionOwner;
  cohort: FollowupCohort;
  runId: string;
  assertCurrent(): void;
};

/** The task owner supplies these operations; projections never import or construct its runtime. */
export interface FollowupCompletionOwner {
  readonly request: FollowupRequest;
  readonly receipt: CreatedDetachedTaskRun;
  readonly accepted: boolean;
  assertCurrent(): void;
  markAccepted(runId: string): void;
  finishExecution(runId: string): void;
  ownsExecution(runId: string): boolean;
  activate(
    runId: string,
    cancel: TaskRunOwner["cancel"] | undefined,
    assertCurrent: () => void,
  ): Promise<() => void>;
  promoteYield(runId: string, entries: readonly SubagentRunRecord[], generation: number): void;
  successor(
    entries: readonly SubagentRunRecord[],
    runId: string,
    assertCurrent: () => void,
  ): FollowupSuccessor;
  prepareSuccessor(successor: FollowupSuccessor): Promise<void>;
  adopt(successor: FollowupSuccessor): void;
  settle(runId: string, reply: FollowupReply, assertCurrent?: () => void): Promise<void>;
  take(timeoutMs?: number): Promise<FollowupReply | undefined>;
  replaceCohortEntry(previous: SubagentRunRecord, next: SubagentRunRecord): () => void;
  close(error?: unknown): void;
}

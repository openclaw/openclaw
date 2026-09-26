import type {
  SubagentCompletionMutation,
  SubagentCompletionMutationResult,
} from "../agents/subagents/completion/subagent-completion-mutation.types.js";
import type { SubagentRunSqliteRow } from "../agents/subagents/registry/subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { bindDeliveryQueueEntry } from "./delivery-queue-sqlite-bound.js";
import type { DeliveryQueueStoredStatus } from "./delivery-queue-sqlite.kernel.js";
import type { QueuedSessionDelivery } from "./session-delivery-queue.records.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

export type SessionDeliveryAgentRunUpdate = {
  expectedMediaUrls?: string[];
  message?: string;
  suppressTextDelivery?: boolean;
};

type PreparedEntry = ReturnType<typeof bindDeliveryQueueEntry>;

export type SessionDeliveryWorkerOperations = {
  "sessionDelivery.mutateSubagentCompletion": {
    input: { writeId: string; mutation: SubagentCompletionMutation };
    output: SubagentCompletionMutationResult & { writeId: string };
  };
  "sessionDelivery.admitSubagentCompletion": {
    input: {
      writeId: string;
      queueEntry: QueuedSessionDelivery;
      expected: SubagentRunRecord;
      subagent: SubagentRunRecord;
    };
    output: {
      writeId: string;
      claimed: boolean;
      status: DeliveryQueueStoredStatus;
      row: SubagentRunSqliteRow;
    };
  };
  "sessionDelivery.enqueue": { input: PreparedEntry; output: void };
  "sessionDelivery.enqueueClaimed": {
    input: PreparedEntry;
    output: { id: string; claimed: boolean; status: DeliveryQueueStoredStatus };
  };
  "sessionDelivery.releaseClaim": { input: { id: string }; output: void };
  "sessionDelivery.defer": { input: { id: string; delayMs: number }; output: void };
  "sessionDelivery.advanceAgentRun": {
    input: { id: string; updates?: SessionDeliveryAgentRunUpdate };
    output: void;
  };
  "sessionDelivery.mergePreparedMedia": {
    input: { id: string; mediaUrl: string; blocksJson: string };
    output: { source: "input" } | { source: "stored"; blocks: Array<Record<string, unknown>> };
  };
  "sessionDelivery.markAttemptStarted": { input: PreparedEntry; output: void };
  "sessionDelivery.markSettlement": { input: PreparedEntry; output: void };
  "sessionDelivery.complete": { input: { id: string }; output: void };
  "sessionDelivery.fail": {
    input: { id: string; error: string; releaseAttemptOwnership?: boolean };
    output: void;
  };
  "sessionDelivery.load": { input: { id: string }; output: QueuedSessionDelivery | null };
  "sessionDelivery.list": { input: undefined; output: QueuedSessionDelivery[] };
  "sessionDelivery.moveToFailed": { input: { id: string }; output: void };
};

export function isSessionDeliveryCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<SessionDeliveryWorkerOperations> {
  return (
    command.type === "sessionDelivery.mutateSubagentCompletion" ||
    command.type === "sessionDelivery.admitSubagentCompletion" ||
    command.type === "sessionDelivery.enqueue" ||
    command.type === "sessionDelivery.enqueueClaimed" ||
    command.type === "sessionDelivery.releaseClaim" ||
    command.type === "sessionDelivery.defer" ||
    command.type === "sessionDelivery.advanceAgentRun" ||
    command.type === "sessionDelivery.mergePreparedMedia" ||
    command.type === "sessionDelivery.markAttemptStarted" ||
    command.type === "sessionDelivery.markSettlement" ||
    command.type === "sessionDelivery.complete" ||
    command.type === "sessionDelivery.fail" ||
    command.type === "sessionDelivery.load" ||
    command.type === "sessionDelivery.list" ||
    command.type === "sessionDelivery.moveToFailed"
  );
}

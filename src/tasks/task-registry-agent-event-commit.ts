import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  captureTaskAgentEventLineage,
  createTaskAgentEventPublication,
  matchesTaskAgentEventTarget,
  readTaskAgentEventCommittedTarget,
  type TaskAgentEventInput,
  type TaskAgentEventReceipt,
} from "./task-registry-agent-event.operation.js";
import { bindTaskRecord } from "./task-registry.store.kernel.js";
import { parseTaskStatus, type TaskRecord } from "./task-registry.types.js";

function hashBoundTaskRecord(bound: ReturnType<typeof bindTaskRecord>): string {
  return createHash("sha256").update(JSON.stringify(bound)).digest("hex");
}

/** Large task detail stays on the framed result/readback path, never this private receipt. */
export function captureTaskAgentEventCommit(
  receipt: TaskAgentEventReceipt,
  bound: ReturnType<typeof bindTaskRecord>,
) {
  return {
    ...captureTaskAgentEventLineage(receipt),
    rowHash: hashBoundTaskRecord(bound),
    previousStatus: receipt.previous.status,
  };
}

export function recoverTaskAgentEventPublication(
  facts: unknown,
  input: TaskAgentEventInput,
  task: TaskRecord | undefined,
) {
  const expectedTask = readTaskAgentEventCommittedTarget(facts, input);
  if (
    !isRecord(facts) ||
    typeof facts.previousStatus !== "string" ||
    !task ||
    !matchesTaskAgentEventTarget(task, { ...input, expectedTask }) ||
    facts.rowHash !== hashBoundTaskRecord(bindTaskRecord(task))
  ) {
    return undefined;
  }
  return createTaskAgentEventPublication(task, parseTaskStatus(facts.previousStatus), input.change);
}

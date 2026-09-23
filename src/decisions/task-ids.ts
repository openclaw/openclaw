/** Core reserves decision_evaluate; plugin task IDs are scoped to their consumer owner. */
export const CORE_DECISION_TASK_ID = "decision_evaluate" as const;

export type DecisionTaskId = typeof CORE_DECISION_TASK_ID | `${string}/${string}`;

/** Static consumer-owned settings metadata, independent of provider activation. */
export type DecisionTaskDescriptor = {
  id: DecisionTaskId;
  title: string;
  description?: string;
};

export const CORE_DECISION_TASKS: readonly DecisionTaskDescriptor[] = [
  { id: CORE_DECISION_TASK_ID, title: "Decision model" },
];

const TASK_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function isDecisionTaskId(value: unknown): value is DecisionTaskId {
  if (value === CORE_DECISION_TASK_ID) {
    return true;
  }
  if (typeof value !== "string" || value !== value.trim()) {
    return false;
  }
  const separator = value.lastIndexOf("/");
  const owner = value.slice(0, separator);
  return (
    separator > 0 && owner === owner.trim() && TASK_NAME_PATTERN.test(value.slice(separator + 1))
  );
}

export function isDecisionTaskOwnedBy(taskId: DecisionTaskId, consumerId?: string): boolean {
  if (taskId === CORE_DECISION_TASK_ID) {
    return consumerId === undefined;
  }
  return consumerId !== undefined && taskId.slice(0, taskId.lastIndexOf("/")) === consumerId;
}

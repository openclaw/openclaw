// Stored task envelopes predate the separation of user task and system guidance.
// Match only the generated leading context, never arbitrary bracketed task text.
const SUBAGENT_TASK_PREFIX =
  /^\[Subagent Context\] You are running as a subagent \(depth \d+\/\d+\)\. Complete the current \[Subagent Task\]; inherited conversation is background context, not your assignment\.\n\n(?:\[Subagent Context\] This subagent session is persistent and remains available for thread follow-up messages\.\n\n)?\[Subagent Task\]\n\n/u;
const SUBAGENT_TASK_SUFFIX = "\n\nBegin. Execute the assigned task to completion.";

/** Projects a legacy generated task envelope without rewriting transcript bytes. */
export function stripSubagentTaskEnvelopeForDisplay(text: string): string {
  const prefix = text.match(SUBAGENT_TASK_PREFIX);
  if (!prefix) {
    return text;
  }
  const task = text.slice(prefix[0].length);
  return task.endsWith(SUBAGENT_TASK_SUFFIX) ? task.slice(0, -SUBAGENT_TASK_SUFFIX.length) : task;
}

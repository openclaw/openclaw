/**
 * Check if an agent's capabilities match a task's required capabilities.
 *
 * Uses ANY-match: agent matches if it has at least ONE of the task's required capabilities.
 * Empty taskCaps = no restriction (any agent can claim).
 * Empty agentCaps = cannot claim capability-gated tasks.
 */
export function matchCapabilities(agentCaps: string[], taskCaps: string[]): boolean {
  if (taskCaps.length === 0) {
    return true;
  }
  if (agentCaps.length === 0) {
    return false;
  }
  const taskSet = new Set(taskCaps);
  return agentCaps.some((cap) => taskSet.has(cap));
}

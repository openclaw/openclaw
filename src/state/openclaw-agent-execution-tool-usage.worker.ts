import type { AgentWorkerOperationContext } from "./openclaw-agent-operation-context.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

type Handlers = WorkerOperationHandlers<AgentWorkerOperationContext>;

export async function loadAgentToolUsageOperations() {
  const kernel = await import("../config/sessions/tool-usage.kernel.js");
  return {
    "toolUsage.prune": (input: { now: number }, { writeTransaction, admit }) =>
      writeTransaction("tool-usage.prune", "Tool usage retention", ({ db }) => {
        kernel.pruneAgentToolUsageInDatabase(db, input.now);
        admit("commit");
      }),
    "toolUsage.flush": (
      input: Parameters<typeof kernel.flushAgentToolUsageInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("tool-usage.flush", "Tool usage", ({ db }) => {
        const applied = kernel.flushAgentToolUsageInDatabase(db, input);
        admit("commit");
        return applied;
      }),
    "toolUsage.reset": (input: { now: number }, { writeTransaction, admit }) =>
      writeTransaction("tool-usage.reset", "Tool usage", ({ db }) => {
        const state = kernel.resetAgentToolUsageInDatabase(db, input.now);
        admit("commit");
        return state;
      }),
    "toolUsage.import": (
      input: Parameters<typeof kernel.commitAgentToolUsageImportInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("tool-usage.import", "Tool usage", ({ db }) => {
        const applied = kernel.commitAgentToolUsageImportInDatabase(db, input);
        admit("commit");
        return applied;
      }),
  } satisfies Handlers;
}

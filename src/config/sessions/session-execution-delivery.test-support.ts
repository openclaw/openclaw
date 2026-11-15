import type {
  AgentDatabaseExecutionScope,
  OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution-contract.js";

type ExecutionModule = typeof import("../../state/openclaw-agent-execution.js");

/** Keep native execution real while each fixture owns its delivery hooks. */
export function decorateSessionExecutionCaptures(
  actual: ExecutionModule,
  decorateWorker: (worker: AgentDatabaseExecutionScope) => AgentDatabaseExecutionScope,
  release?: (owner: OpenClawAgentDatabaseExecution) => Promise<void>,
): Pick<
  ExecutionModule,
  "captureOpenClawAgentDatabaseExecution" | "captureOpenClawAgentDatabasePreparationExecution"
> {
  const decorate = (owner: OpenClawAgentDatabaseExecution): OpenClawAgentDatabaseExecution => ({
    ...owner,
    get fileIdentity() {
      return owner.fileIdentity;
    },
    runExisting: (source, operation, options) =>
      owner.runExisting(source, (worker) => operation(decorateWorker(worker)), options),
    ...(release ? { release: () => release(owner) } : {}),
  });
  return {
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ) => decorate(actual.captureOpenClawAgentDatabaseExecution(...args)),
    captureOpenClawAgentDatabasePreparationExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabasePreparationExecution>
    ) => decorate(actual.captureOpenClawAgentDatabasePreparationExecution(...args)),
  };
}

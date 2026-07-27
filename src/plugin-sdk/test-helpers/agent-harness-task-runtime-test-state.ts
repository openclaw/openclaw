import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createAgentHarnessTaskRuntimeScope } from "../../tasks/agent-harness-task-runtime-scope.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import {
  createAgentHarnessTaskRuntime,
  type AgentHarnessTaskRuntime,
  type AgentHarnessTaskRuntimeScopeParams,
} from "../agent-harness-task-runtime.js";

type AgentHarnessTaskRuntimeTestStateOptions = Omit<AgentHarnessTaskRuntimeScopeParams, "scope"> & {
  label: string;
  requesterSessionKey: string;
};

/**
 * Runs a bundled-extension integration test against the real task store.
 * The host-issued scope stays behind this repo-local test facade.
 */
export async function withAgentHarnessTaskRuntimeTestState<T>(
  options: AgentHarnessTaskRuntimeTestStateOptions,
  fn: (runtime: AgentHarnessTaskRuntime) => Promise<T> | T,
): Promise<T> {
  return withStateDirEnv(`${options.label}-`, async () => {
    resetTaskRegistryForTests({ persist: false });
    const runtime = createAgentHarnessTaskRuntime({
      runtime: options.runtime,
      taskKind: options.taskKind,
      runIdPrefix: options.runIdPrefix,
      scope: createAgentHarnessTaskRuntimeScope({
        requesterSessionKey: options.requesterSessionKey,
      }),
    });
    try {
      return await fn(runtime);
    } finally {
      resetTaskRegistryForTests({ persist: false });
      closeOpenClawStateDatabaseForTest();
    }
  });
}

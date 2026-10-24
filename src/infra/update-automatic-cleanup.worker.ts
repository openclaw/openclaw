import type { MessagePort } from "node:worker_threads";
import { cleanupCompletedUpdateRecovery } from "../commands/update-automatic-cleanup.js";
import {
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import type { UpdateStepResult } from "./update-step-result.js";
import { serveWorkerTasks } from "./worker-task-server.js";

export type AutomaticCleanupInput = {
  runId: string;
  env: NodeJS.ProcessEnv;
  authority: MessagePort;
};

serveWorkerTasks<UpdateStepResult | undefined, AutomaticCleanupInput>(
  async (input, _channel, control) => {
    // The existing host admission channel rechecks the real Gateway owner before
    // each effect. A PID, serialized run ID, or successful result is not authority.
    const assertCurrent = () => {
      control.throwIfCancelled();
      withSqliteWorkerOperationAdmission({ port: input.authority }, () =>
        requestSqliteWorkerOperationAdmission({
          stage: "transaction",
          facts: undefined,
          deadlineMs: 30_000,
        }),
      );
    };
    try {
      return await control.runNativeSection(() =>
        cleanupCompletedUpdateRecovery(input.runId, input.env, assertCurrent),
      );
    } finally {
      input.authority.close();
    }
  },
);

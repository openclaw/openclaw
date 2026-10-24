import type { MessagePort } from "node:worker_threads";
import {
  inspectSessionSqliteRecovery,
  type RecoveryCleanupReport,
} from "../commands/doctor-session-sqlite-recovery-inventory.js";
import { retireOwnedSessionSqliteRecovery } from "../commands/doctor-session-sqlite-retirement.js";
import { cleanupCompletedUpdateRecovery } from "../commands/update-automatic-cleanup.js";
import { createConfigIO } from "../config/io.js";
import {
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";
import type { UpdateStepResult } from "./update-step-result.js";
import { serveWorkerTasks } from "./worker-task-server.js";

export type AutomaticCleanupInput = {
  runId?: string;
  dryRun?: boolean;
  env: NodeJS.ProcessEnv;
  authority: MessagePort;
};

serveWorkerTasks<UpdateStepResult | RecoveryCleanupReport | undefined, AutomaticCleanupInput>(
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
      return await control.runNativeSection(async () => {
        if (input.runId) {
          return cleanupCompletedUpdateRecovery(input.runId, input.env, assertCurrent);
        }
        assertCurrent();
        const io = createConfigIO({
          env: input.env,
          observe: false,
          pluginValidation: "core-only",
        });
        const readConfig = () => io.readSourceConfigBestEffort();
        const preview = inspectSessionSqliteRecovery({ cfg: await readConfig(), env: input.env });
        assertCurrent();
        return input.dryRun
          ? preview
          : retireOwnedSessionSqliteRecovery(
              { env: input.env, preview, readConfig, confirm: async () => true },
              { assertCurrent },
            );
      });
    } finally {
      input.authority.close();
    }
  },
);

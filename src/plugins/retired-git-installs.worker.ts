import { updateConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import {
  nextRetiredGitInstallRecords,
  RETIRED_GIT_INSTALLS_STATE_KEY,
  type RetiredGitInstallStateReplacement,
} from "./retired-git-installs.kernel.js";

export const retiredGitInstallOperations = {
  "retiredGitInstalls.replace": (
    input: RetiredGitInstallStateReplacement,
    { write }: WorkerWriteOperationContext,
  ) =>
    write(
      ({ db }) => {
        updateConfigMachineStateInDatabase<unknown[]>(
          db,
          RETIRED_GIT_INSTALLS_STATE_KEY,
          (current) => nextRetiredGitInstallRecords(current, input),
          Date.now(),
        );
      },
      { operationLabel: "retired-git-installs.replace" },
    ),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

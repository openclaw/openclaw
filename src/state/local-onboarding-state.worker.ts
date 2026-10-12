import { readConfigMachineStateRowInDatabase } from "./config-machine-state-row.js";
import { writeConfigMachineStateInDatabase } from "./config-machine-state-write.js";
import {
  localOnboardingStateKey,
  normalizeLocalOnboardingState,
  type LocalOnboardingState,
} from "./local-onboarding-state-shared.js";
import type { WorkerOperations, WorkerWriteOperationContext } from "./worker-operation-registry.js";

export const localOnboardingOperations = {
  "localOnboarding.complete": (
    input: { configPath: string; runId: string; nowMs?: number },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(
      ({ db }) => {
        const key = localOnboardingStateKey(input.configPath);
        const row = readConfigMachineStateRowInDatabase(db, key);
        const current = normalizeLocalOnboardingState(
          row ? (JSON.parse(row.value_json) as unknown) : undefined,
          input.configPath,
        );
        if (!current || current.runId !== input.runId) {
          return false;
        }
        if (current.status !== "completed") {
          const completed: LocalOnboardingState = {
            ...current,
            status: "completed",
            completedAtMs: input.nowMs ?? Date.now(),
          };
          writeConfigMachineStateInDatabase(db, key, completed);
        }
        return true;
      },
      { operationLabel: "local-onboarding.complete" },
    ),
};

export type LocalOnboardingWorkerOperations = WorkerOperations<typeof localOnboardingOperations>;

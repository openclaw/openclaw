import { commitUserBackgroundInDatabase } from "./user-background.kernel.js";
import { ensureUserBackgroundSchema } from "./user-background.store.js";
import type { UserBackgroundWriteInput } from "./user-background.types.js";
import { ensureUserPreferencesSchema } from "./user-preferences.store.js";
import type { WorkerOperations, WorkerWriteOperationContext } from "./worker-operation-registry.js";

export const userBackgroundOperations = {
  "userBackground.write": (
    input: UserBackgroundWriteInput,
    context: WorkerWriteOperationContext,
  ) => {
    const options = { ...context.stateOptions(), database: context.open() };
    if (input.image) {
      ensureUserBackgroundSchema(options);
    }
    ensureUserPreferencesSchema(options);
    return context.writeAdmitted(({ db }) => commitUserBackgroundInDatabase(db, input), {
      operationLabel: "users.background.set",
    });
  },
};
export type UserBackgroundWorkerOperations = WorkerOperations<typeof userBackgroundOperations>;

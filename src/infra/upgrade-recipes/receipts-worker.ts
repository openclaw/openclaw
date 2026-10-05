import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import {
  captureOpenClawStateReadContext,
  captureOpenClawStateWorkerContext,
} from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { runSqliteReadOnlyOperation } from "../sqlite-readonly-worker.js";
import { hasSqliteWorkerOutcomeUnknown } from "../sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "../sqlite-worker-store.js";
import type { UpdateRunWriteOptions } from "../update-run-write.async.js";
import {
  upgradeRecipeStepReceiptSchema,
  type UpgradeRecipeStepBinding,
} from "./receipts-contract.js";
import { createUpgradeRecipeStepReceiptRecorder } from "./receipts.js";

/** Compose detailed receipts with the existing update writer and native child settlement. */
export function createFencedUpgradeRecipeStepReceiptRecorder(
  binding: UpgradeRecipeStepBinding,
  options: UpdateRunWriteOptions & {
    assertCurrent: () => void;
    assertEffectsSettled: () => void;
  },
) {
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const context = options.context ?? captureOpenClawStateWorkerContext({ ...options, env });
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.signal?.throwIfAborted();
    options.assertCurrent();
  };
  return createUpgradeRecipeStepReceiptRecorder(binding, {
    assertCurrent,
    assertEffectsSettled: options.assertEffectsSettled,
    read: async (selected) => {
      assertCurrent();
      const source = captureOpenClawStateReadContext(context.admission.databasePath);
      source.admission.assertCurrent();
      const result = await runSqliteReadOnlyOperation(
        context.admission.databasePath,
        { type: "upgradeRecipeSteps.read", input: selected },
        {
          source: "canonical",
          expectedIdentity: source.admission.identity.key,
          env,
          signal: options.signal,
        },
      );
      source.admission.assertCurrent();
      assertCurrent();
      return result === null ? null : upgradeRecipeStepReceiptSchema.parse(result);
    },
    record: async (input) => {
      options.assertAccepting?.();
      assertCurrent();
      const pending = runOpenClawStateWorkerOperation(
        context,
        (scope) => scope.execute({ type: "upgradeRecipeSteps.record", input }),
        {
          existingOnly: true,
          assertCurrent,
          createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
            context.admission.databasePath,
          ]),
        },
      ).catch((error: unknown) => {
        if (hasSqliteWorkerOutcomeUnknown(error) && !hasCommandProcessCleanupError(error)) {
          throw new CommandProcessCleanupError({ cause: error });
        }
        throw error;
      });
      options.retainSettlement?.(pending.then(() => undefined));
      const receipt = await pending;
      assertCurrent();
      return upgradeRecipeStepReceiptSchema.parse(receipt);
    },
  });
}

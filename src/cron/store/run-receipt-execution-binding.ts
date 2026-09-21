import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import {
  executionOwnerBindingFromAdmission,
  type ExecutionOwnerBindingResult,
} from "../../audit/execution-owner-binding.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { CronRunReceiptHandle } from "./run-receipt-store.js";

/** Binds the exact admitted execution without changing the receipt lifecycle. */
export async function bindCronRunReceiptExecution(params: {
  admitted: AdmittedRunContext;
  handle: CronRunReceiptHandle;
  options?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
  context?: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
}): Promise<ExecutionOwnerBindingResult> {
  const binding = executionOwnerBindingFromAdmission(params.admitted);
  if (!binding) {
    return "disabled";
  }
  const context = params.context ?? captureOpenClawStateWorkerContext(params.options);
  const input = { handle: { ...params.handle }, binding };
  const assertOwnerCurrent = params.assertCurrent;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertOwnerCurrent?.();
  };
  const [{ runOpenClawStateWorkerOperation }, { createSqliteWorkerWriteAdmission }] =
    await Promise.all([
      import("../../state/openclaw-state-worker-store.js"),
      import("../../infra/sqlite-worker-store.js"),
    ]);
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "cron.bindReceiptExecution", input }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}

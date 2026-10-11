import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../../state/openclaw-state-worker-store.types.js";
import { withCronReceiptAuthorityMutation } from "./receipt-authority-owner.js";

export function runCronStoreAuthorityOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope) => Promise<T>,
): Promise<T> {
  return withCronReceiptAuthorityMutation(context, (mutation) =>
    runOpenClawStateWorkerOperation(
      mutation.context,
      (scope) => {
        // Store retirement after submission may race the write; no host wait holds its transaction.
        mutation.assertCurrent();
        return operation(scope);
      },
      { assertCurrent: mutation.assertCurrent },
    ),
  );
}

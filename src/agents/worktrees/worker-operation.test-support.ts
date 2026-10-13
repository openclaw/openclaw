import { vi } from "vitest";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../../state/openclaw-state-worker-store.types.js";

type OperationOptions = Parameters<typeof stateWorker.runOpenClawStateWorkerOperation>[2];

export function interceptWorktreeWorkerOperation(
  intercept: (execute: DomainScope["execute"]) => DomainScope["execute"],
  configure?: (options: OperationOptions) => OperationOptions,
) {
  const run = stateWorker.runOpenClawStateWorkerOperation;
  return vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      run(
        context,
        (scope) => operation({ execute: intercept(scope.execute.bind(scope)) }),
        configure ? configure(options) : options,
      ),
    );
}

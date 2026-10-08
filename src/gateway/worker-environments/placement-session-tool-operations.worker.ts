import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import { createPlacementSessionToolOperationKernel } from "./placement-session-tool-operations.kernel.js";
import type { PlacementSessionToolReceipt } from "./placement-session-tool-operations.receipt.js";

type Kernel = ReturnType<typeof createPlacementSessionToolOperationKernel>;
type KernelArgs<Method extends keyof Kernel> = Parameters<Kernel[Method]>;

function operation<Args extends unknown[]>(
  type: string,
  execute: (tools: Kernel, args: Args) => PlacementSessionToolReceipt,
) {
  return (
    input: { args: Args; instanceId: string; nowMs?: number },
    { open }: WorkerOperationContext,
  ): PlacementSessionToolReceipt =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const tools = createPlacementSessionToolOperationKernel({
          db,
          instanceId: input.instanceId,
          now: () => input.nowMs ?? Date.now(),
        });
        const receipt = execute(tools, input.args);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: receipt });
        deferSqliteWorkerCommitReceipt(db, receipt);
        return receipt;
      },
      { database: open() },
      { operationLabel: type },
    );
}

export const placementSessionToolOperations = {
  "placementTools.authorize": operation(
    "placementTools.authorize",
    (tools, args: KernelArgs<"authorize">) => ({ toolNames: tools.authorize(...args) }),
  ),
  "placementTools.seal": operation("placementTools.seal", (tools, args: KernelArgs<"seal">) => {
    tools.seal(...args);
    return { toolNames: null };
  }),
  "placementTools.clear": operation("placementTools.clear", (tools, args: KernelArgs<"clear">) => ({
    changed: tools.clear(...args),
    toolNames: null,
  })),
  "placementTools.begin": operation("placementTools.begin", (tools, args: KernelArgs<"begin">) => ({
    result: tools.begin(...args),
  })),
  "placementTools.bindChild": operation(
    "placementTools.bindChild",
    (tools, args: KernelArgs<"bindChild">) => ({ changed: tools.bindChild(...args) }),
  ),
  "placementTools.complete": operation(
    "placementTools.complete",
    (tools, args: KernelArgs<"complete">) => ({ changed: tools.complete(...args) }),
  ),
  "placementTools.abandon": operation(
    "placementTools.abandon",
    (tools, args: KernelArgs<"abandon">) => ({
      changed: tools.abandon(...args),
    }),
  ),
  "placementTools.recover": operation(
    "placementTools.recover",
    (tools, _args: KernelArgs<"recover">) => ({ recovered: tools.recover() }),
  ),
} satisfies WorkerOperationHandlers;

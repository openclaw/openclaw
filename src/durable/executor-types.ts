import type { DurableRuntimeStepHandlerResult, DurableRuntimeRegistry } from "./registry.js";
import type { DurableRuntimeStepType, DurableRuntimeStore } from "./types.js";

export type DurableExecutorRunOnceOptions = {
  store: DurableRuntimeStore;
  registry: DurableRuntimeRegistry;
  workerId: string;
  claimTtlMs?: number;
  operationKind: string;
  operationVersion?: string;
  stepType?: DurableRuntimeStepType;
  now?: () => number;
};

export type DurableExecutorRunOnceResult =
  | {
      claimed: false;
      reason: "no_runnable_step";
    }
  | {
      claimed: true;
      runtimeRunId: string;
      stepId: string;
      outcome:
        | DurableRuntimeStepHandlerResult["kind"]
        | "no_handler"
        | "handler_exception"
        | "claim_lost";
    };

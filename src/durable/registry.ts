import type {
  DurableRuntimeRun,
  DurableRuntimeStep,
  DurableRuntimeStepType,
  DurableRuntimeStore,
  DurableRuntimeTimer,
} from "./types.js";

export type DurableRuntimeDefinition = {
  operationKind: string;
  version: string;
  description?: string;
  stepTypes?: DurableRuntimeStepType[];
  metadata?: Record<string, unknown>;
};

export type DurableRuntimeStepSideEffectPolicy =
  | "none"
  | "idempotent"
  | "non_idempotent"
  | "unknown";

export type DurableRuntimeStepHandlerContext = {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  step: DurableRuntimeStep;
  workerId: string;
  now(): number;
  heartbeat(payload?: Record<string, unknown>): void;
};

export type DurableRuntimeStepHandlerResult =
  | {
      kind: "succeeded";
      output?: Record<string, unknown>;
      outputRef?: string;
      checkpointRef?: string;
      completeRun?: boolean;
    }
  | {
      kind: "failed";
      error?: Record<string, unknown>;
      retryAfterMs?: number;
      checkpointRef?: string;
      completeRun?: boolean;
    }
  | {
      kind: "waiting_signal";
      reason?: string;
      checkpointRef?: string;
    }
  | {
      kind: "waiting_timer";
      dueAt: number;
      timerType?: DurableRuntimeTimer["timerType"];
      reason?: string;
      checkpointRef?: string;
    }
  | {
      kind: "unknown_after_side_effect";
      reason?: string;
      checkpointRef?: string;
    };

export type DurableRuntimeStepHandler = (
  context: DurableRuntimeStepHandlerContext,
) => DurableRuntimeStepHandlerResult | Promise<DurableRuntimeStepHandlerResult>;

export type DurableRuntimeStepHandlerOptions = {
  sideEffectPolicy?: DurableRuntimeStepSideEffectPolicy;
};

export type DurableRuntimeStepHandlerRegistration = {
  handler: DurableRuntimeStepHandler;
  sideEffectPolicy: DurableRuntimeStepSideEffectPolicy;
};

export type DurableRuntimeRegistry = {
  registerRuntime(definition: DurableRuntimeDefinition): void;
  getRuntime(operationKind: string, version?: string): DurableRuntimeDefinition | undefined;
  listRuntimes(): DurableRuntimeDefinition[];
  registerStepHandler(
    stepType: DurableRuntimeStepType,
    handler: DurableRuntimeStepHandler,
    options?: DurableRuntimeStepHandlerOptions,
  ): void;
  getStepHandler(stepType: DurableRuntimeStepType): DurableRuntimeStepHandler | undefined;
  getStepHandlerRegistration(
    stepType: DurableRuntimeStepType,
  ): DurableRuntimeStepHandlerRegistration | undefined;
};

function runtimeKey(operationKind: string, version: string): string {
  return `${operationKind}@${version}`;
}

export function createDurableRuntimeRegistry(): DurableRuntimeRegistry {
  const runtimes = new Map<string, DurableRuntimeDefinition>();
  const handlers = new Map<DurableRuntimeStepType, DurableRuntimeStepHandlerRegistration>();

  return {
    registerRuntime(definition: DurableRuntimeDefinition): void {
      runtimes.set(runtimeKey(definition.operationKind, definition.version), { ...definition });
    },

    getRuntime(operationKind: string, version = "1"): DurableRuntimeDefinition | undefined {
      return runtimes.get(runtimeKey(operationKind, version));
    },

    listRuntimes(): DurableRuntimeDefinition[] {
      return Array.from(runtimes.values(), (definition) => ({ ...definition }));
    },

    registerStepHandler(
      stepType: DurableRuntimeStepType,
      handler: DurableRuntimeStepHandler,
      options?: DurableRuntimeStepHandlerOptions,
    ): void {
      handlers.set(stepType, {
        handler,
        sideEffectPolicy: options?.sideEffectPolicy ?? "unknown",
      });
    },

    getStepHandler(stepType: DurableRuntimeStepType): DurableRuntimeStepHandler | undefined {
      return handlers.get(stepType)?.handler;
    },

    getStepHandlerRegistration(
      stepType: DurableRuntimeStepType,
    ): DurableRuntimeStepHandlerRegistration | undefined {
      const registration = handlers.get(stepType);
      return registration
        ? {
            handler: registration.handler,
            sideEffectPolicy: registration.sideEffectPolicy,
          }
        : undefined;
    },
  };
}

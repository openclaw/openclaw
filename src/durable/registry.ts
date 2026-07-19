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
  claimToken: string;
  now(): number;
  heartbeat(payload?: Record<string, unknown>): boolean;
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
  operationVersion?: string;
};

export type DurableRuntimeStepHandlerRegistration = {
  operationKind: string;
  operationVersion: string;
  stepType: DurableRuntimeStepType;
  handler: DurableRuntimeStepHandler;
  sideEffectPolicy: DurableRuntimeStepSideEffectPolicy;
};

export type DurableRuntimeRegistry = {
  registerRuntime(definition: DurableRuntimeDefinition): void;
  getRuntime(operationKind: string, version?: string): DurableRuntimeDefinition | undefined;
  listRuntimes(): DurableRuntimeDefinition[];
  registerStepHandler(
    operationKind: string,
    stepType: DurableRuntimeStepType,
    handler: DurableRuntimeStepHandler,
    options?: DurableRuntimeStepHandlerOptions,
  ): void;
  getStepHandler(
    operationKind: string,
    stepType: DurableRuntimeStepType,
    operationVersion?: string,
  ): DurableRuntimeStepHandler | undefined;
  getStepHandlerRegistration(
    operationKind: string,
    stepType: DurableRuntimeStepType,
    operationVersion?: string,
  ): DurableRuntimeStepHandlerRegistration | undefined;
  hasStepHandlers(operationKind: string, operationVersion?: string): boolean;
};

function runtimeKey(operationKind: string, version: string): string {
  return JSON.stringify([operationKind, version]);
}

function handlerKey(
  operationKind: string,
  version: string,
  stepType: DurableRuntimeStepType,
): string {
  return JSON.stringify([operationKind, version, stepType]);
}

function operationLabel(operationKind: string, version: string): string {
  return `${operationKind}@${version}`;
}

function cloneDefinition(definition: DurableRuntimeDefinition): DurableRuntimeDefinition {
  return {
    ...definition,
    stepTypes: definition.stepTypes ? [...definition.stepTypes] : undefined,
    metadata: definition.metadata ? { ...definition.metadata } : undefined,
  };
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Durable runtime ${label} must not be empty`);
  }
  return normalized;
}

export function createDurableRuntimeRegistry(): DurableRuntimeRegistry {
  const runtimes = new Map<string, DurableRuntimeDefinition>();
  const handlers = new Map<string, DurableRuntimeStepHandlerRegistration>();

  return {
    registerRuntime(definition: DurableRuntimeDefinition): void {
      const operationKind = requireNonEmpty(definition.operationKind, "operationKind");
      const version = requireNonEmpty(definition.version, "version");
      const key = runtimeKey(operationKind, version);
      if (runtimes.has(key)) {
        throw new Error(
          `Durable runtime operation is already registered: ${operationLabel(operationKind, version)}`,
        );
      }
      runtimes.set(key, cloneDefinition({ ...definition, operationKind, version }));
    },

    getRuntime(operationKind: string, version = "1"): DurableRuntimeDefinition | undefined {
      const definition = runtimes.get(runtimeKey(operationKind, version));
      return definition ? cloneDefinition(definition) : undefined;
    },

    listRuntimes(): DurableRuntimeDefinition[] {
      return [...runtimes.values()].map(cloneDefinition);
    },

    registerStepHandler(
      operationKind: string,
      stepType: DurableRuntimeStepType,
      handler: DurableRuntimeStepHandler,
      options?: DurableRuntimeStepHandlerOptions,
    ): void {
      const normalizedOperationKind = requireNonEmpty(operationKind, "operationKind");
      const operationVersion = requireNonEmpty(options?.operationVersion ?? "1", "version");
      const runtime = runtimes.get(runtimeKey(normalizedOperationKind, operationVersion));
      if (!runtime) {
        throw new Error(
          `Durable runtime operation is not registered: ${operationLabel(normalizedOperationKind, operationVersion)}`,
        );
      }
      if (runtime.stepTypes && !runtime.stepTypes.includes(stepType)) {
        throw new Error(
          `Durable runtime step type ${stepType} is not declared by ${operationLabel(normalizedOperationKind, operationVersion)}`,
        );
      }
      const key = handlerKey(normalizedOperationKind, operationVersion, stepType);
      if (handlers.has(key)) {
        throw new Error(
          `Durable runtime step handler is already registered: ${operationLabel(normalizedOperationKind, operationVersion)}:${stepType}`,
        );
      }
      handlers.set(key, {
        operationKind: normalizedOperationKind,
        operationVersion,
        stepType,
        handler,
        sideEffectPolicy: options?.sideEffectPolicy ?? "unknown",
      });
    },

    getStepHandler(
      operationKind: string,
      stepType: DurableRuntimeStepType,
      operationVersion = "1",
    ): DurableRuntimeStepHandler | undefined {
      return handlers.get(handlerKey(operationKind, operationVersion, stepType))?.handler;
    },

    getStepHandlerRegistration(
      operationKind: string,
      stepType: DurableRuntimeStepType,
      operationVersion = "1",
    ): DurableRuntimeStepHandlerRegistration | undefined {
      const registration = handlers.get(handlerKey(operationKind, operationVersion, stepType));
      return registration
        ? {
            operationKind: registration.operationKind,
            operationVersion: registration.operationVersion,
            stepType: registration.stepType,
            handler: registration.handler,
            sideEffectPolicy: registration.sideEffectPolicy,
          }
        : undefined;
    },

    hasStepHandlers(operationKind: string, operationVersion = "1"): boolean {
      return [...handlers.values()].some(
        (registration) =>
          registration.operationKind === operationKind &&
          registration.operationVersion === operationVersion,
      );
    },
  };
}

let durableRuntimeRegistry: DurableRuntimeRegistry | undefined;

export function getDurableRuntimeRegistry(): DurableRuntimeRegistry {
  durableRuntimeRegistry ??= createDurableRuntimeRegistry();
  return durableRuntimeRegistry;
}

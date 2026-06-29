import type {
  DurableWorkflowRun,
  DurableWorkflowStep,
  DurableWorkflowStepType,
  DurableWorkflowStore,
  DurableWorkflowTimer,
} from "./types.js";

export type DurableWorkflowDefinition = {
  workflowId: string;
  version: string;
  description?: string;
  stepTypes?: DurableWorkflowStepType[];
  metadata?: Record<string, unknown>;
};

export type DurableWorkflowStepSideEffectPolicy =
  | "none"
  | "idempotent"
  | "non_idempotent"
  | "unknown";

export type DurableWorkflowStepHandlerContext = {
  store: DurableWorkflowStore;
  run: DurableWorkflowRun;
  step: DurableWorkflowStep;
  workerId: string;
  now(): number;
  heartbeat(payload?: Record<string, unknown>): void;
};

export type DurableWorkflowStepHandlerResult =
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
      timerType?: DurableWorkflowTimer["timerType"];
      reason?: string;
      checkpointRef?: string;
    }
  | {
      kind: "unknown_after_side_effect";
      reason?: string;
      checkpointRef?: string;
    };

export type DurableWorkflowStepHandler = (
  context: DurableWorkflowStepHandlerContext,
) => DurableWorkflowStepHandlerResult | Promise<DurableWorkflowStepHandlerResult>;

export type DurableWorkflowStepHandlerOptions = {
  sideEffectPolicy?: DurableWorkflowStepSideEffectPolicy;
};

export type DurableWorkflowStepHandlerRegistration = {
  handler: DurableWorkflowStepHandler;
  sideEffectPolicy: DurableWorkflowStepSideEffectPolicy;
};

export type DurableWorkflowRegistry = {
  registerWorkflow(definition: DurableWorkflowDefinition): void;
  getWorkflow(workflowId: string, version?: string): DurableWorkflowDefinition | undefined;
  listWorkflows(): DurableWorkflowDefinition[];
  registerStepHandler(
    stepType: DurableWorkflowStepType,
    handler: DurableWorkflowStepHandler,
    options?: DurableWorkflowStepHandlerOptions,
  ): void;
  getStepHandler(stepType: DurableWorkflowStepType): DurableWorkflowStepHandler | undefined;
  getStepHandlerRegistration(
    stepType: DurableWorkflowStepType,
  ): DurableWorkflowStepHandlerRegistration | undefined;
};

function workflowKey(workflowId: string, version: string): string {
  return `${workflowId}@${version}`;
}

export function createDurableWorkflowRegistry(): DurableWorkflowRegistry {
  const workflows = new Map<string, DurableWorkflowDefinition>();
  const handlers = new Map<DurableWorkflowStepType, DurableWorkflowStepHandlerRegistration>();

  return {
    registerWorkflow(definition: DurableWorkflowDefinition): void {
      workflows.set(workflowKey(definition.workflowId, definition.version), { ...definition });
    },

    getWorkflow(workflowId: string, version = "1"): DurableWorkflowDefinition | undefined {
      return workflows.get(workflowKey(workflowId, version));
    },

    listWorkflows(): DurableWorkflowDefinition[] {
      return [...workflows.values()].map((definition) => ({ ...definition }));
    },

    registerStepHandler(
      stepType: DurableWorkflowStepType,
      handler: DurableWorkflowStepHandler,
      options?: DurableWorkflowStepHandlerOptions,
    ): void {
      handlers.set(stepType, {
        handler,
        sideEffectPolicy: options?.sideEffectPolicy ?? "unknown",
      });
    },

    getStepHandler(stepType: DurableWorkflowStepType): DurableWorkflowStepHandler | undefined {
      return handlers.get(stepType)?.handler;
    },

    getStepHandlerRegistration(
      stepType: DurableWorkflowStepType,
    ): DurableWorkflowStepHandlerRegistration | undefined {
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

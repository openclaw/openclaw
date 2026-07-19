export type DurableRuntimeHealthComponent =
  | "intake"
  | "agent_turn"
  | "subagent_owner"
  | "startup"
  | "recovery"
  | "wake_dispatcher";

export type DurableRuntimeHealthFailure = {
  component: DurableRuntimeHealthComponent;
  operation: string;
  message: string;
  failedAt: number;
  failureCount: number;
};

export type DurableRuntimeHealthSnapshot = {
  status: "healthy" | "degraded";
  lastSuccessAt?: number;
  lastFailure?: DurableRuntimeHealthFailure;
};

let lastSuccessAt: number | undefined;
let lastFailure: DurableRuntimeHealthFailure | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function recordDurableRuntimeHealthSuccess(now = Date.now()): void {
  lastSuccessAt = now;
}

export function recordDurableRuntimeHealthFailure(params: {
  component: DurableRuntimeHealthComponent;
  operation: string;
  error: unknown;
  now?: number;
}): DurableRuntimeHealthFailure {
  const failure: DurableRuntimeHealthFailure = {
    component: params.component,
    operation: params.operation,
    message: errorMessage(params.error).slice(0, 500),
    failedAt: params.now ?? Date.now(),
    failureCount: (lastFailure?.failureCount ?? 0) + 1,
  };
  lastFailure = failure;
  return failure;
}

export function getDurableRuntimeHealthSnapshot(): DurableRuntimeHealthSnapshot {
  return {
    status:
      lastFailure && (!lastSuccessAt || lastFailure.failedAt >= lastSuccessAt)
        ? "degraded"
        : "healthy",
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(lastFailure ? { lastFailure: { ...lastFailure } } : {}),
  };
}

export function resetDurableRuntimeHealthForTests(): void {
  lastSuccessAt = undefined;
  lastFailure = undefined;
}

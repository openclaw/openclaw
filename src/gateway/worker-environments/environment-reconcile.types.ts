export type WorkerEnvironmentReconcileCore = (
  signal?: AbortSignal,
  retainProviderSettlement?: (settled: Promise<void>) => void,
) => Promise<void>;

export type WorkerEnvironmentReconcileGuard = (
  environmentId: string,
  reconcileCore: WorkerEnvironmentReconcileCore,
  signal: AbortSignal,
) => Promise<void>;

type InstallMode = "install" | "update";

type InstallModeOptions<TLogger> = {
  logger?: TLogger;
  mode?: InstallMode;
  dryRun?: boolean;
};

export type TimedInstallModeOptions<TLogger> = InstallModeOptions<TLogger> & {
  timeoutMs?: number;
  /** Resolved work policy: null is unbounded; omission retains install defaults. */
  workTimeoutMs?: number | null;
};

/** Keep a deliberate work deadline separate from bounded metadata/probe defaults. */
export function resolveInstallWorkTimeoutMs(
  workTimeoutMs: number | null | undefined,
  defaultTimeoutMs: number | undefined,
): number | undefined {
  return workTimeoutMs === null ? undefined : (workTimeoutMs ?? defaultTimeoutMs);
}

export function resolveInstallModeOptions<TLogger>(
  params: InstallModeOptions<TLogger>,
  defaultLogger: TLogger,
): {
  logger: TLogger;
  mode: InstallMode;
  dryRun: boolean;
} {
  return {
    logger: params.logger ?? defaultLogger,
    mode: params.mode ?? "install",
    dryRun: params.dryRun ?? false,
  };
}

export function resolveTimedInstallModeOptions<TLogger>(
  params: TimedInstallModeOptions<TLogger>,
  defaultLogger: TLogger,
  defaultTimeoutMs = 120_000,
): {
  logger: TLogger;
  timeoutMs: number;
  workTimeoutMs: number | null | undefined;
  mode: InstallMode;
  dryRun: boolean;
} {
  return {
    ...resolveInstallModeOptions(params, defaultLogger),
    timeoutMs: params.timeoutMs ?? defaultTimeoutMs,
    // Target publication may switch update to install when the target is absent.
    // Carry the original request's work policy through that nested operation.
    workTimeoutMs:
      params.workTimeoutMs !== undefined
        ? params.workTimeoutMs
        : params.mode === "update"
          ? (params.timeoutMs ?? null)
          : undefined,
  };
}

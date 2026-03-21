type StartupPhaseLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export async function runLoggedGatewayStartupPhase<T>(params: {
  phase: string;
  log: StartupPhaseLogger;
  run: () => Promise<T> | T;
  slowAfterMs?: number;
}): Promise<T> {
  const startedAt = Date.now();
  const slowAfterMs = Math.max(0, params.slowAfterMs ?? 5_000);

  params.log.info(`[phase:${params.phase}] starting`);
  try {
    const result = await params.run();
    const elapsedMs = Date.now() - startedAt;
    const message = `[phase:${params.phase}] completed in ${elapsedMs}ms`;
    if (elapsedMs >= slowAfterMs) {
      params.log.warn(message);
    } else {
      params.log.info(message);
    }
    return result;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const detail = err instanceof Error && err.message ? err.message : String(err);
    params.log.warn(`[phase:${params.phase}] failed after ${elapsedMs}ms: ${detail}`);
    throw err;
  }
}

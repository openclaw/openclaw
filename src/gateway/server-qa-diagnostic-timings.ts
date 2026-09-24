const QA_DIAGNOSTIC_ABORT_MS_ENV = "QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS";
const MIN_QA_DIAGNOSTIC_ABORT_MS = 30_000;

export function resolveQaDiagnosticHeartbeatTimings(
  env: NodeJS.ProcessEnv,
): { stuckSessionWarnMs: number; stuckSessionAbortMs: number } | undefined {
  if (!env.OPENCLAW_QA_PARENT_PID) {
    return undefined;
  }
  const raw = env[QA_DIAGNOSTIC_ABORT_MS_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const stuckSessionAbortMs = Number(raw);
  if (
    !Number.isSafeInteger(stuckSessionAbortMs) ||
    stuckSessionAbortMs < MIN_QA_DIAGNOSTIC_ABORT_MS
  ) {
    return undefined;
  }
  return {
    stuckSessionWarnMs: Math.max(15_000, Math.floor(stuckSessionAbortMs / 2)),
    stuckSessionAbortMs,
  };
}

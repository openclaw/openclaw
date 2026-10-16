import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/model-providers");

/** Catalog exceptions may contain credentials or response bodies; log only closed diagnostics. */
export function warnProviderCatalogFailure(params: {
  provider: string;
  phase: "live-catalog" | "provider-discovery";
  startedAt: number;
  error: unknown;
  deadlineExceeded?: boolean;
  httpStatus?: number;
}): void {
  const httpStatus =
    typeof params.httpStatus === "number" &&
    Number.isInteger(params.httpStatus) &&
    params.httpStatus >= 100 &&
    params.httpStatus <= 599
      ? params.httpStatus
      : undefined;
  let errorName: unknown;
  try {
    errorName = params.error instanceof Error ? params.error.name : undefined;
  } catch {
    // A thrown value may have an accessor; diagnostics must not replace graceful failure.
  }
  const reason = params.deadlineExceeded
    ? "timeout"
    : httpStatus !== undefined
      ? "http"
      : errorName === "TimeoutError"
        ? "timeout"
        : errorName === "AbortError"
          ? "aborted"
          : "unknown";
  log.warn("Provider catalog discovery failed; skipping unavailable catalog", {
    provider: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(params.provider)
      ? params.provider
      : "unknown",
    phase: params.phase,
    reason,
    elapsedMs: Math.max(0, Math.round(performance.now() - params.startedAt)),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  });
}

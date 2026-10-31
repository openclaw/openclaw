export function otelTraceConfig(
  endpoint: { endpoint: string } | { tracesEndpoint: string },
  sampleRate: number,
  flushIntervalMs: number,
) {
  return {
    enabled: true,
    otel: {
      enabled: true,
      protocol: "http/protobuf" as const,
      traces: true,
      metrics: false,
      logs: false,
      captureContent: false,
      ...endpoint,
      sampleRate,
      flushIntervalMs,
    },
  };
}

export async function settleOtelCleanup(...cleanups: Array<() => Promise<void>>) {
  const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "OTel fixture cleanup failed");
  }
}

import { signalCheck, signalRpcRequest } from "./client.js";

export type SignalProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs: number;
  version?: string | null;
};

export async function probeSignal(
  baseUrl: string,
  timeoutMs: number,
): Promise<SignalProbe> {
  const started = Date.now();
  const result: SignalProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
    version: null,
  };
  const check = await signalCheck(baseUrl, timeoutMs);
  if (!check.ok) {
    return {
      ...result,
      status: check.status ?? null,
      error: check.error ?? "unreachable",
      elapsedMs: Date.now() - started,
    };
  }
  try {
    const version = await signalRpcRequest<string>("version", undefined, {
      baseUrl,
      timeoutMs,
    });
    result.version = typeof version === "string" ? version : null;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return {
    ...result,
    ok: true,
    status: check.status ?? null,
    elapsedMs: Date.now() - started,
  };
}

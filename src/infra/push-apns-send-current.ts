export function apnsSendInvalidatedError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("APNs send invalidated");
}

function throwIfApnsSendAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw apnsSendInvalidatedError(signal);
  }
}

/** Recheck cancellation after the asynchronous registration-ownership check. */
export async function requireCurrentApnsSend(params: {
  signal?: AbortSignal;
  isCurrent?: () => Promise<boolean>;
}): Promise<void> {
  throwIfApnsSendAborted(params.signal);
  if (params.isCurrent && !(await params.isCurrent())) {
    throw new Error("APNs send invalidated");
  }
  throwIfApnsSendAborted(params.signal);
}

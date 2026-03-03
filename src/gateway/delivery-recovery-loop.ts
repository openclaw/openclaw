export const DELIVERY_RECOVERY_INTERVAL_MS = 30_000;

type IntervalHandle = ReturnType<typeof setInterval> | number;
type SetIntervalLike = (handler: () => void, timeout?: number) => IntervalHandle;
type ClearIntervalLike = (handle: IntervalHandle) => void;

type DeliveryRecoveryLoopParams = {
  enabled: boolean;
  run: () => Promise<void>;
  onError: (err: unknown) => void;
  intervalMs?: number;
  setIntervalFn?: SetIntervalLike;
  clearIntervalFn?: ClearIntervalLike;
};

export type DeliveryRecoveryLoop = {
  stop: () => Promise<void>;
};

export function startDeliveryRecoveryLoop(
  params: DeliveryRecoveryLoopParams,
): DeliveryRecoveryLoop {
  const setIntervalFn: SetIntervalLike =
    params.setIntervalFn ?? ((handler, timeout) => setInterval(handler, timeout));
  const clearIntervalFn: ClearIntervalLike =
    params.clearIntervalFn ?? ((handle) => clearInterval(handle));
  const intervalMs = params.intervalMs ?? DELIVERY_RECOVERY_INTERVAL_MS;
  let interval: IntervalHandle | null = null;
  let recoveryInFlight = false;
  let inFlightPromise: Promise<void> | null = null;

  const runRecovery = async () => {
    if (recoveryInFlight) {
      return;
    }
    recoveryInFlight = true;
    inFlightPromise = params.run();
    try {
      await inFlightPromise;
    } finally {
      recoveryInFlight = false;
      inFlightPromise = null;
    }
  };

  const trigger = () => {
    void runRecovery().catch((err) => params.onError(err));
  };

  if (params.enabled) {
    trigger();
    interval = setIntervalFn(trigger, intervalMs);
  }

  return {
    stop: async () => {
      if (interval) {
        clearIntervalFn(interval);
        interval = null;
      }
      if (inFlightPromise) {
        await inFlightPromise.catch(() => undefined);
      }
    },
  };
}

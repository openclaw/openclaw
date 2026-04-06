import { logWarn } from "../../logger.js";

export type TypingLease = {
  refresh: () => Promise<void>;
  stop: () => void;
};

type CreateTypingLeaseParams<TPulseArgs> = {
  defaultIntervalMs: number;
  errorLabel: string;
  intervalMs?: number;
  pulse: (params: TPulseArgs) => Promise<unknown>;
  pulseArgs: TPulseArgs;
};

export async function createTypingLease<TPulseArgs>(
  params: CreateTypingLeaseParams<TPulseArgs>,
): Promise<TypingLease> {
  const intervalMs =
    typeof params.intervalMs === "number" && Number.isFinite(params.intervalMs)
      ? Math.max(1_000, Math.floor(params.intervalMs))
      : params.defaultIntervalMs;

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const pulse = async () => {
    if (stopped) {
      return;
    }
    await params.pulse(params.pulseArgs);
  };

  await pulse();

  timer = setInterval(() => {
    // Background lease refreshes must never escape as unhandled rejections.
    void pulse().catch((err) => {
      logWarn(`plugins: ${params.errorLabel} typing pulse failed: ${String(err)}`);
    });
  }, intervalMs);
  timer.unref?.();

  return {
    refresh: async () => {
      await pulse();
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

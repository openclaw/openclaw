import type { OpenClawConfig } from "../../config/config.js";
import { logWarn } from "../../logger.js";

export type CreateMSTeamsTypingLeaseParams = {
  to: string;
  cfg?: OpenClawConfig;
  intervalMs?: number;
  pulse: (params: { to: string; cfg?: OpenClawConfig }) => Promise<unknown>;
};

const DEFAULT_MSTEAMS_TYPING_INTERVAL_MS = 4_000;

export async function createMSTeamsTypingLease(params: CreateMSTeamsTypingLeaseParams): Promise<{
  refresh: () => Promise<void>;
  stop: () => void;
}> {
  const intervalMs =
    typeof params.intervalMs === "number" && Number.isFinite(params.intervalMs)
      ? Math.max(1_000, Math.floor(params.intervalMs))
      : DEFAULT_MSTEAMS_TYPING_INTERVAL_MS;
  let stopped = false;

  const refresh = async () => {
    if (stopped) {
      return;
    }
    await params.pulse({
      to: params.to,
      cfg: params.cfg,
    });
  };

  await refresh();

  const timer = setInterval(() => {
    void refresh().catch((err) => {
      logWarn(`plugins: msteams typing pulse failed: ${String(err)}`);
    });
  }, intervalMs);
  timer.unref?.();

  return {
    refresh,
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
    },
  };
}

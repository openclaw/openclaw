import type { OpenClawConfig } from "../../config/config.js";
import { logWarn } from "../../logger.js";

export type CreateTelegramTypingLeaseParams = {
  to: string;
  accountId?: string;
  cfg?: OpenClawConfig;
  intervalMs?: number;
  messageThreadId?: number;
  pulse: (params: {
    to: string;
    accountId?: string;
    cfg?: OpenClawConfig;
    messageThreadId?: number;
  }) => Promise<unknown>;
};

export async function createTelegramTypingLease(params: CreateTelegramTypingLeaseParams): Promise<{
  refresh: () => Promise<void>;
  stop: () => void;
}> {
  const intervalMs =
    typeof params.intervalMs === "number" && Number.isFinite(params.intervalMs)
      ? Math.max(1_000, Math.floor(params.intervalMs))
      : 4_000;
  let stopped = false;

  const refresh = async () => {
    if (stopped) {
      return;
    }
    await params.pulse({
      to: params.to,
      accountId: params.accountId,
      cfg: params.cfg,
      messageThreadId: params.messageThreadId,
    });
  };

  await refresh();

  const timer = setInterval(() => {
    // Background lease refreshes must never escape as unhandled rejections.
    void refresh().catch((err) => {
      logWarn(`plugins: telegram typing pulse failed: ${String(err)}`);
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

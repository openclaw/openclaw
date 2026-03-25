import { logWarn } from "../../logger.js";

export type CreateDiscordTypingLeaseParams = {
  channelId: string;
  accountId?: string;
  cfg?: ReturnType<typeof import("../../config/config.js").loadConfig>;
  intervalMs?: number;
  pulse: (params: {
    channelId: string;
    accountId?: string;
    cfg?: ReturnType<typeof import("../../config/config.js").loadConfig>;
  }) => Promise<void>;
};

const DEFAULT_DISCORD_TYPING_INTERVAL_MS = 8_000;

export async function createDiscordTypingLease(params: CreateDiscordTypingLeaseParams): Promise<{
  refresh: () => Promise<void>;
  stop: () => void;
}> {
  const intervalMs =
    typeof params.intervalMs === "number" && Number.isFinite(params.intervalMs)
      ? Math.max(1_000, Math.floor(params.intervalMs))
      : DEFAULT_DISCORD_TYPING_INTERVAL_MS;

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const pulse = async () => {
    if (stopped) {
      return;
    }
    await params.pulse({
      channelId: params.channelId,
      accountId: params.accountId,
      cfg: params.cfg,
    });
  };

  await pulse();

  timer = setInterval(() => {
    // Background lease refreshes must never escape as unhandled rejections.
    void pulse().catch((err) => {
      logWarn(`plugins: discord typing pulse failed: ${String(err)}`);
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

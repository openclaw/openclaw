import type { OpenClawConfig } from "../../config/config.js";

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
  const intervalMs = Math.max(1000, Math.floor(params.intervalMs ?? 4_000));
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
    void refresh();
  }, intervalMs);

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

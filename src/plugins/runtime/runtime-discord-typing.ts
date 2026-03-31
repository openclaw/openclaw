import { createTypingLease } from "./typing-lease.js";

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
  return await createTypingLease({
    defaultIntervalMs: DEFAULT_DISCORD_TYPING_INTERVAL_MS,
    errorLabel: "discord",
    intervalMs: params.intervalMs,
    pulse: params.pulse,
    pulseArgs: {
      channelId: params.channelId,
      accountId: params.accountId,
      cfg: params.cfg,
    },
  });
}

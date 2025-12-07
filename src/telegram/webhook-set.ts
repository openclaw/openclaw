import { Bot } from "grammy";

export async function setTelegramWebhook(opts: {
  token: string;
  url: string;
  secret?: string;
  dropPendingUpdates?: boolean;
}) {
  const bot = new Bot(opts.token);
  await bot.api.setWebhook(opts.url, {
    secret_token: opts.secret,
    drop_pending_updates: opts.dropPendingUpdates ?? false,
  });
}

export async function deleteTelegramWebhook(opts: { token: string }) {
  const bot = new Bot(opts.token);
  await bot.api.deleteWebhook();
}

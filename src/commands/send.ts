import type { CliDeps } from "../cli/deps.js";
import { listPortListeners } from "../cli/ports.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { startGatewayServer } from "../gateway/server.js";
import { success } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";

export async function sendCommand(
  opts: {
    to: string;
    message: string;
    provider?: string;
    json?: boolean;
    dryRun?: boolean;
    media?: string;
    spawnGateway?: boolean;
  },
  deps: CliDeps,
  runtime: RuntimeEnv,
) {
  const provider = (opts.provider ?? "whatsapp").toLowerCase();

  if (opts.dryRun) {
    runtime.log(
      `[dry-run] would send via ${provider} -> ${opts.to}: ${opts.message}${opts.media ? ` (media ${opts.media})` : ""}`,
    );
    return;
  }

  if (provider === "telegram") {
    const result = await deps.sendMessageTelegram(opts.to, opts.message, {
      token: process.env.TELEGRAM_BOT_TOKEN,
      mediaUrl: opts.media,
    });
    runtime.log(
      success(
        `✅ Sent via telegram. Message ID: ${result.messageId} (chat ${result.chatId})`,
      ),
    );
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          {
            provider: "telegram",
            via: "direct",
            to: opts.to,
            chatId: result.chatId,
            messageId: result.messageId,
            mediaUrl: opts.media ?? null,
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  // Always send via gateway over WS to avoid multi-session corruption.
  const sendViaGateway = async () =>
    callGateway<{
      messageId: string;
    }>({
      url: "ws://127.0.0.1:18789",
      method: "send",
      params: {
        to: opts.to,
        message: opts.message,
        mediaUrl: opts.media,
        idempotencyKey: randomIdempotencyKey(),
      },
      timeoutMs: 10_000,
      clientName: "cli",
      mode: "cli",
    });

  let result: { messageId: string } | undefined;
  try {
    result = await sendViaGateway();
  } catch (err) {
    if (!opts.spawnGateway) throw err;
    // Only spawn when nothing is listening.
    try {
      const listeners = listPortListeners(18789);
      if (listeners.length > 0) throw err;
      await startGatewayServer(18789);
      result = await sendViaGateway();
    } catch {
      throw err;
    }
  }

  runtime.log(
    success(
      `✅ Sent via gateway. Message ID: ${result.messageId ?? "unknown"}`,
    ),
  );
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          provider: "web",
          via: "gateway",
          to: opts.to,
          messageId: result.messageId,
          mediaUrl: opts.media ?? null,
        },
        null,
        2,
      ),
    );
  }
}

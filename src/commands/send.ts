import type { CliDeps } from "../cli/deps.js";
import { info, success } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { sendViaIpc } from "../web/ipc.js";

export async function sendCommand(
  opts: {
    to: string;
    message: string;
    provider?: string;
    json?: boolean;
    dryRun?: boolean;
    media?: string;
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

  // Try to send via IPC to running gateway first (avoids Signal session corruption)
  const ipcResult = await sendViaIpc(opts.to, opts.message, opts.media);
  if (ipcResult) {
    if (ipcResult.success) {
      runtime.log(
        success(`✅ Sent via gateway IPC. Message ID: ${ipcResult.messageId}`),
      );
      if (opts.json) {
        runtime.log(
          JSON.stringify(
            {
              provider: "web",
              via: "ipc",
              to: opts.to,
              messageId: ipcResult.messageId,
              mediaUrl: opts.media ?? null,
            },
            null,
            2,
          ),
        );
      }
      return;
    }
    // IPC failed but gateway is running - warn and fall back
    runtime.log(
      info(
        `IPC send failed (${ipcResult.error}), falling back to direct connection`,
      ),
    );
  }

  // Fall back to direct connection (creates new Baileys socket)
  const res = await deps
    .sendMessageWhatsApp(opts.to, opts.message, {
      verbose: false,
      mediaUrl: opts.media,
    })
    .catch((err) => {
      runtime.error(`❌ Web send failed: ${String(err)}`);
      throw err;
    });
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          provider: "web",
          via: "direct",
          to: opts.to,
          messageId: res.messageId,
          mediaUrl: opts.media ?? null,
        },
        null,
        2,
      ),
    );
  }
}

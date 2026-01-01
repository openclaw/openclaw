import fs from "node:fs/promises";
import path from "node:path";

import { confirm, multiselect, note, text } from "@clack/prompts";

import type { ClawdisConfig } from "../config/config.js";
import { loginWeb } from "../provider-web.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveWebAuthDir } from "../web/session.js";
import { detectBinary, guardCancel } from "./onboard-helpers.js";
import type { ProviderChoice } from "./onboard-types.js";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectWhatsAppLinked(): Promise<boolean> {
  const credsPath = path.join(resolveWebAuthDir(), "creds.json");
  return await pathExists(credsPath);
}

export async function setupProviders(
  cfg: ClawdisConfig,
  runtime: RuntimeEnv,
): Promise<ClawdisConfig> {
  const whatsappLinked = await detectWhatsAppLinked();
  const telegramEnv = Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
  const discordEnv = Boolean(process.env.DISCORD_BOT_TOKEN?.trim());
  const telegramConfigured = Boolean(
    telegramEnv || cfg.telegram?.botToken || cfg.telegram?.tokenFile,
  );
  const discordConfigured = Boolean(discordEnv || cfg.discord?.token);
  const signalConfigured = Boolean(
    cfg.signal?.account || cfg.signal?.httpUrl || cfg.signal?.httpPort,
  );
  const signalCliDetected = await detectBinary("signal-cli");

  note(
    [
      `WhatsApp: ${whatsappLinked ? "linked" : "not linked"}`,
      `Telegram: ${telegramConfigured ? "configured" : "needs token"}`,
      `Discord: ${discordConfigured ? "configured" : "needs token"}`,
      `Signal: ${signalConfigured ? "configured" : "needs setup"}`,
      `signal-cli: ${signalCliDetected ? "found" : "missing"}`,
    ].join("\n"),
    "Provider status",
  );

  const shouldConfigure = guardCancel(
    await confirm({
      message: "Configure chat providers now?",
      initialValue: true,
    }),
    runtime,
  );
  if (!shouldConfigure) return cfg;

  const selection = guardCancel(
    await multiselect({
      message: "Select providers",
      options: [
        {
          value: "whatsapp",
          label: "WhatsApp (QR link)",
          hint: whatsappLinked ? "linked" : "not linked",
        },
        {
          value: "telegram",
          label: "Telegram (Bot API)",
          hint: telegramConfigured ? "configured" : "needs token",
        },
        {
          value: "discord",
          label: "Discord (Bot API)",
          hint: discordConfigured ? "configured" : "needs token",
        },
        {
          value: "signal",
          label: "Signal (signal-cli)",
          hint: signalCliDetected ? "signal-cli found" : "signal-cli missing",
        },
      ],
    }),
    runtime,
  ) as ProviderChoice[];

  let next = cfg;

  if (selection.includes("whatsapp")) {
    const wantsLink = guardCancel(
      await confirm({
        message: whatsappLinked
          ? "WhatsApp already linked. Re-link now?"
          : "Link WhatsApp now (QR)?",
        initialValue: !whatsappLinked,
      }),
      runtime,
    );
    if (wantsLink) {
      try {
        await loginWeb(false, "web");
      } catch (err) {
        runtime.error(`WhatsApp login failed: ${String(err)}`);
      }
    } else if (!whatsappLinked) {
      note("Run `clawdis login` later to link WhatsApp.", "WhatsApp");
    }
  }

  if (selection.includes("telegram")) {
    let token: string | null = null;
    if (telegramEnv && !cfg.telegram?.botToken) {
      const keepEnv = guardCancel(
        await confirm({
          message: "TELEGRAM_BOT_TOKEN detected. Use env var?",
          initialValue: true,
        }),
        runtime,
      );
      if (!keepEnv) {
        token = String(
          guardCancel(
            await text({
              message: "Enter Telegram bot token",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
            runtime,
          ),
        ).trim();
      }
    } else if (cfg.telegram?.botToken) {
      const keep = guardCancel(
        await confirm({
          message: "Telegram token already configured. Keep it?",
          initialValue: true,
        }),
        runtime,
      );
      if (!keep) {
        token = String(
          guardCancel(
            await text({
              message: "Enter Telegram bot token",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
            runtime,
          ),
        ).trim();
      }
    } else {
      token = String(
        guardCancel(
          await text({
            message: "Enter Telegram bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
          runtime,
        ),
      ).trim();
    }

    if (token) {
      next = {
        ...next,
        telegram: {
          ...next.telegram,
          enabled: true,
          botToken: token,
        },
      };
    }
  }

  if (selection.includes("discord")) {
    let token: string | null = null;
    if (discordEnv && !cfg.discord?.token) {
      const keepEnv = guardCancel(
        await confirm({
          message: "DISCORD_BOT_TOKEN detected. Use env var?",
          initialValue: true,
        }),
        runtime,
      );
      if (!keepEnv) {
        token = String(
          guardCancel(
            await text({
              message: "Enter Discord bot token",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
            runtime,
          ),
        ).trim();
      }
    } else if (cfg.discord?.token) {
      const keep = guardCancel(
        await confirm({
          message: "Discord token already configured. Keep it?",
          initialValue: true,
        }),
        runtime,
      );
      if (!keep) {
        token = String(
          guardCancel(
            await text({
              message: "Enter Discord bot token",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
            runtime,
          ),
        ).trim();
      }
    } else {
      token = String(
        guardCancel(
          await text({
            message: "Enter Discord bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
          runtime,
        ),
      ).trim();
    }

    if (token) {
      next = {
        ...next,
        discord: {
          ...next.discord,
          enabled: true,
          token,
        },
      };
    }
  }

  if (selection.includes("signal")) {
    if (!signalCliDetected) {
      note(
        "signal-cli not found. Install it, then rerun this step or set signal.cliPath.",
        "Signal",
      );
    }

    let account = cfg.signal?.account ?? "";
    if (account) {
      const keep = guardCancel(
        await confirm({
          message: `Signal account set (${account}). Keep it?`,
          initialValue: true,
        }),
        runtime,
      );
      if (!keep) account = "";
    }

    if (!account) {
      account = String(
        guardCancel(
          await text({
            message: "Signal bot number (E.164)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
          runtime,
        ),
      ).trim();
    }

    if (account) {
      next = {
        ...next,
        signal: {
          ...next.signal,
          enabled: true,
          account,
          cliPath: next.signal?.cliPath ?? "signal-cli",
        },
      };
    }

    note(
      [
        'Link device with: signal-cli link -n "Clawdis"',
        "Scan QR in Signal → Linked Devices",
        "Then run: clawdis gateway call providers.status --params '{\"probe\":true}'",
      ].join("\n"),
      "Signal next steps",
    );
  }

  return next;
}

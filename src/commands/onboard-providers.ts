import fs from "node:fs/promises";
import path from "node:path";

import { confirm, multiselect, note, select, text } from "@clack/prompts";
import chalk from "chalk";

import type { ClawdisConfig } from "../config/config.js";
import { loginWeb } from "../provider-web.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeE164 } from "../utils.js";
import { resolveWebAuthDir } from "../web/session.js";
import { detectBinary, guardCancel } from "./onboard-helpers.js";
import type { ProviderChoice } from "./onboard-types.js";
import { installSignalCli } from "./signal-install.js";

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

function noteProviderPrimer(): void {
  note(
    [
      "WhatsApp: links via WhatsApp Web (scan QR), stores creds for future sends.",
      "Telegram: Bot API (token from @BotFather), replies via your bot.",
      "Discord: Bot token from Discord Developer Portal; invite bot to your server.",
      "Signal: signal-cli as a linked device (recommended: separate bot number).",
      "iMessage: local imsg CLI (JSON-RPC over stdio) reading Messages DB.",
    ].join("\n"),
    "How providers work",
  );
}

function noteTelegramTokenHelp(): void {
  note(
    [
      "1) Open Telegram and chat with @BotFather",
      "2) Run /newbot (or /mybots)",
      "3) Copy the token (looks like 123456:ABC...)",
      "Tip: you can also set TELEGRAM_BOT_TOKEN in your env.",
    ].join("\n"),
    "Telegram bot token",
  );
}

function noteDiscordTokenHelp(): void {
  note(
    [
      "1) Discord Developer Portal → Applications → New Application",
      "2) Bot → Add Bot → Reset Token → copy token",
      "3) OAuth2 → URL Generator → scope 'bot' → invite to your server",
      "Tip: enable Message Content Intent if you need message text.",
    ].join("\n"),
    "Discord bot token",
  );
}

export async function setupProviders(
  cfg: ClawdisConfig,
  runtime: RuntimeEnv,
  options?: { allowDisable?: boolean; allowSignalInstall?: boolean },
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
  const signalCliPath = cfg.signal?.cliPath ?? "signal-cli";
  const signalCliDetected = await detectBinary(signalCliPath);
  const imessageConfigured = Boolean(
    cfg.imessage?.cliPath || cfg.imessage?.dbPath || cfg.imessage?.allowFrom,
  );
  const imessageCliPath = cfg.imessage?.cliPath ?? "imsg";
  const imessageCliDetected = await detectBinary(imessageCliPath);

  note(
    [
      `WhatsApp: ${
        whatsappLinked ? chalk.green("linked") : chalk.red("not linked")
      }`,
      `Telegram: ${
        telegramConfigured
          ? chalk.green("configured")
          : chalk.yellow("needs token")
      }`,
      `Discord: ${
        discordConfigured
          ? chalk.green("configured")
          : chalk.yellow("needs token")
      }`,
      `Signal: ${
        signalConfigured
          ? chalk.green("configured")
          : chalk.yellow("needs setup")
      }`,
      `iMessage: ${
        imessageConfigured
          ? chalk.green("configured")
          : chalk.yellow("needs setup")
      }`,
      `signal-cli: ${
        signalCliDetected ? chalk.green("found") : chalk.red("missing")
      } (${signalCliPath})`,
      `imsg: ${
        imessageCliDetected ? chalk.green("found") : chalk.red("missing")
      } (${imessageCliPath})`,
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

  noteProviderPrimer();

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
        {
          value: "imessage",
          label: "iMessage (imsg)",
          hint: imessageCliDetected ? "imsg found" : "imsg missing",
        },
      ],
    }),
    runtime,
  ) as ProviderChoice[];

  let next = cfg;

  if (selection.includes("whatsapp")) {
    if (!whatsappLinked) {
      note(
        [
          "Scan the QR with WhatsApp on your phone.",
          "Credentials are stored under ~/.clawdis/credentials/ for future runs.",
        ].join("\n"),
        "WhatsApp linking",
      );
    }
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

    const existingAllowFrom = cfg.routing?.allowFrom ?? [];
    if (existingAllowFrom.length === 0) {
      note(
        [
          "WhatsApp direct chats are gated by `routing.allowFrom`.",
          'Default (unset) = self-chat only; use "*" to allow anyone.',
        ].join("\n"),
        "Allowlist (recommended)",
      );
      const mode = guardCancel(
        await select({
          message: "Who can trigger the bot via WhatsApp?",
          options: [
            { value: "self", label: "Self-chat only (default)" },
            { value: "list", label: "Specific numbers (recommended)" },
            { value: "any", label: "Anyone (*)" },
          ],
        }),
        runtime,
      ) as "self" | "list" | "any";

      if (mode === "any") {
        next = {
          ...next,
          routing: { ...next.routing, allowFrom: ["*"] },
        };
      } else if (mode === "list") {
        const allowRaw = guardCancel(
          await text({
            message: "Allowed sender numbers (comma-separated, E.164)",
            placeholder: "+15555550123, +447700900123",
            validate: (value) => {
              const raw = String(value ?? "").trim();
              if (!raw) return "Required";
              const parts = raw
                .split(/[\n,;]+/g)
                .map((p) => p.trim())
                .filter(Boolean);
              if (parts.length === 0) return "Required";
              for (const part of parts) {
                if (part === "*") continue;
                const normalized = normalizeE164(part);
                if (!normalized) return `Invalid number: ${part}`;
              }
              return undefined;
            },
          }),
          runtime,
        );

        const parts = String(allowRaw)
          .split(/[\n,;]+/g)
          .map((p) => p.trim())
          .filter(Boolean);
        const normalized = parts.map((part) =>
          part === "*" ? "*" : normalizeE164(part),
        );
        const unique = [...new Set(normalized.filter(Boolean))];
        next = {
          ...next,
          routing: { ...next.routing, allowFrom: unique },
        };
      }
    }
  }

  if (selection.includes("telegram")) {
    let token: string | null = null;
    if (!telegramConfigured) {
      noteTelegramTokenHelp();
    }
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
    if (!discordConfigured) {
      noteDiscordTokenHelp();
    }
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
    let resolvedCliPath = signalCliPath;
    let cliDetected = signalCliDetected;
    if (options?.allowSignalInstall) {
      const wantsInstall = guardCancel(
        await confirm({
          message: cliDetected
            ? "signal-cli detected. Reinstall/update now?"
            : "signal-cli not found. Install now?",
          initialValue: !cliDetected,
        }),
        runtime,
      );
      if (wantsInstall) {
        try {
          const result = await installSignalCli(runtime);
          if (result.ok && result.cliPath) {
            cliDetected = true;
            resolvedCliPath = result.cliPath;
            note(`Installed signal-cli at ${result.cliPath}`, "Signal");
          } else if (!result.ok) {
            note(result.error ?? "signal-cli install failed.", "Signal");
          }
        } catch (err) {
          note(`signal-cli install failed: ${String(err)}`, "Signal");
        }
      }
    }

    if (!cliDetected) {
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
          cliPath: resolvedCliPath ?? "signal-cli",
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

  if (selection.includes("imessage")) {
    let resolvedCliPath = imessageCliPath;
    if (!imessageCliDetected) {
      const entered = guardCancel(
        await text({
          message: "imsg CLI path",
          initialValue: resolvedCliPath,
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
        runtime,
      );
      resolvedCliPath = String(entered).trim();
      if (!resolvedCliPath) {
        note("imsg CLI path required to enable iMessage.", "iMessage");
      }
    }

    if (resolvedCliPath) {
      next = {
        ...next,
        imessage: {
          ...next.imessage,
          enabled: true,
          cliPath: resolvedCliPath,
        },
      };
    }

    note(
      [
        "Ensure Clawdis has Full Disk Access to Messages DB.",
        "Grant Automation permission for Messages when prompted.",
        "List chats with: imsg chats --limit 20",
      ].join("\n"),
      "iMessage next steps",
    );
  }

  if (options?.allowDisable) {
    if (!selection.includes("telegram") && telegramConfigured) {
      const disable = guardCancel(
        await confirm({
          message: "Disable Telegram provider?",
          initialValue: false,
        }),
        runtime,
      );
      if (disable) {
        next = {
          ...next,
          telegram: { ...next.telegram, enabled: false },
        };
      }
    }

    if (!selection.includes("discord") && discordConfigured) {
      const disable = guardCancel(
        await confirm({
          message: "Disable Discord provider?",
          initialValue: false,
        }),
        runtime,
      );
      if (disable) {
        next = {
          ...next,
          discord: { ...next.discord, enabled: false },
        };
      }
    }

    if (!selection.includes("signal") && signalConfigured) {
      const disable = guardCancel(
        await confirm({
          message: "Disable Signal provider?",
          initialValue: false,
        }),
        runtime,
      );
      if (disable) {
        next = {
          ...next,
          signal: { ...next.signal, enabled: false },
        };
      }
    }

    if (!selection.includes("imessage") && imessageConfigured) {
      const disable = guardCancel(
        await confirm({
          message: "Disable iMessage provider?",
          initialValue: false,
        }),
        runtime,
      );
      if (disable) {
        next = {
          ...next,
          imessage: { ...next.imessage, enabled: false },
        };
      }
    }
  }

  return next;
}

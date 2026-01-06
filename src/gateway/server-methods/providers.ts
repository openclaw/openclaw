import type { ClawdbotConfig } from "../../config/config.js";
import {
  loadConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../../config/config.js";
import { type DiscordProbe, probeDiscord } from "../../discord/probe.js";
import { type IMessageProbe, probeIMessage } from "../../imessage/probe.js";
import { probeSignal, type SignalProbe } from "../../signal/probe.js";
import { probeSlack, type SlackProbe } from "../../slack/probe.js";
import {
  resolveSlackAppToken,
  resolveSlackBotToken,
} from "../../slack/token.js";
import { probeTelegram, type TelegramProbe } from "../../telegram/probe.js";
import { resolveTelegramToken } from "../../telegram/token.js";
import {
  listEnabledWhatsAppAccounts,
  resolveDefaultWhatsAppAccountId,
} from "../../web/accounts.js";
import {
  getWebAuthAgeMs,
  readWebSelfId,
  webAuthExists,
} from "../../web/session.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateProvidersStatusParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const providersHandlers: GatewayRequestHandlers = {
  "providers.status": async ({ params, respond, context }) => {
    if (!validateProvidersStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid providers.status params: ${formatValidationErrors(validateProvidersStatusParams.errors)}`,
        ),
      );
      return;
    }
    const probe = (params as { probe?: boolean }).probe === true;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" ? Math.max(1000, timeoutMsRaw) : 10_000;
    const cfg = loadConfig();
    const telegramCfg = cfg.telegram;
    const telegramEnabled =
      Boolean(telegramCfg) && telegramCfg?.enabled !== false;
    const { token: telegramToken, source: tokenSource } = telegramEnabled
      ? resolveTelegramToken(cfg)
      : { token: "", source: "none" as const };
    let telegramProbe: TelegramProbe | undefined;
    let lastProbeAt: number | null = null;
    if (probe && telegramToken && telegramEnabled) {
      telegramProbe = await probeTelegram(
        telegramToken,
        timeoutMs,
        telegramCfg?.proxy,
      );
      lastProbeAt = Date.now();
    }

    const discordCfg = cfg.discord;
    const discordEnabled = Boolean(discordCfg) && discordCfg?.enabled !== false;
    const discordEnvToken = discordEnabled
      ? process.env.DISCORD_BOT_TOKEN?.trim()
      : "";
    const discordConfigToken = discordEnabled ? discordCfg?.token?.trim() : "";
    const discordToken = discordEnvToken || discordConfigToken || "";
    const discordTokenSource = discordEnvToken
      ? "env"
      : discordConfigToken
        ? "config"
        : "none";
    let discordProbe: DiscordProbe | undefined;
    let discordLastProbeAt: number | null = null;
    if (probe && discordToken && discordEnabled) {
      discordProbe = await probeDiscord(discordToken, timeoutMs);
      discordLastProbeAt = Date.now();
    }

    const slackCfg = cfg.slack;
    const slackEnabled = slackCfg?.enabled !== false;
    const slackBotEnvToken = slackEnabled
      ? resolveSlackBotToken(process.env.SLACK_BOT_TOKEN)
      : undefined;
    const slackBotConfigToken = slackEnabled
      ? resolveSlackBotToken(slackCfg?.botToken)
      : undefined;
    const slackBotToken = slackBotEnvToken ?? slackBotConfigToken ?? "";
    const slackBotTokenSource = slackBotEnvToken
      ? "env"
      : slackBotConfigToken
        ? "config"
        : "none";
    const slackAppEnvToken = slackEnabled
      ? resolveSlackAppToken(process.env.SLACK_APP_TOKEN)
      : undefined;
    const slackAppConfigToken = slackEnabled
      ? resolveSlackAppToken(slackCfg?.appToken)
      : undefined;
    const slackAppToken = slackAppEnvToken ?? slackAppConfigToken ?? "";
    const slackAppTokenSource = slackAppEnvToken
      ? "env"
      : slackAppConfigToken
        ? "config"
        : "none";
    const slackConfigured =
      slackEnabled && Boolean(slackBotToken) && Boolean(slackAppToken);
    let slackProbe: SlackProbe | undefined;
    let slackLastProbeAt: number | null = null;
    if (probe && slackConfigured) {
      slackProbe = await probeSlack(slackBotToken, timeoutMs);
      slackLastProbeAt = Date.now();
    }

    const signalCfg = cfg.signal;
    const signalEnabled = signalCfg?.enabled !== false;
    const signalHost = signalCfg?.httpHost?.trim() || "127.0.0.1";
    const signalPort = signalCfg?.httpPort ?? 8080;
    const signalBaseUrl =
      signalCfg?.httpUrl?.trim() || `http://${signalHost}:${signalPort}`;
    const signalConfigured =
      Boolean(signalCfg) &&
      signalEnabled &&
      Boolean(
        signalCfg?.account?.trim() ||
          signalCfg?.httpUrl?.trim() ||
          signalCfg?.cliPath?.trim() ||
          signalCfg?.httpHost?.trim() ||
          typeof signalCfg?.httpPort === "number" ||
          typeof signalCfg?.autoStart === "boolean",
      );
    let signalProbe: SignalProbe | undefined;
    let signalLastProbeAt: number | null = null;
    if (probe && signalConfigured) {
      signalProbe = await probeSignal(signalBaseUrl, timeoutMs);
      signalLastProbeAt = Date.now();
    }

    const imessageCfg = cfg.imessage;
    const imessageEnabled = imessageCfg?.enabled !== false;
    const imessageConfigured = Boolean(imessageCfg) && imessageEnabled;
    let imessageProbe: IMessageProbe | undefined;
    let imessageLastProbeAt: number | null = null;
    if (probe && imessageConfigured) {
      imessageProbe = await probeIMessage(timeoutMs);
      imessageLastProbeAt = Date.now();
    }

    const runtime = context.getRuntimeSnapshot();
    const defaultWhatsAppAccountId = resolveDefaultWhatsAppAccountId(cfg);
    const enabledWhatsAppAccounts = listEnabledWhatsAppAccounts(cfg);
    const defaultWhatsAppAccount =
      enabledWhatsAppAccounts.find(
        (account) => account.accountId === defaultWhatsAppAccountId,
      ) ?? enabledWhatsAppAccounts[0];
    const linked = defaultWhatsAppAccount
      ? await webAuthExists(defaultWhatsAppAccount.authDir)
      : false;
    const authAgeMs = defaultWhatsAppAccount
      ? getWebAuthAgeMs(defaultWhatsAppAccount.authDir)
      : null;
    const self = defaultWhatsAppAccount
      ? readWebSelfId(defaultWhatsAppAccount.authDir)
      : { e164: null, jid: null };

    const defaultWhatsAppStatus = {
      running: false,
      connected: false,
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastMessageAt: null,
      lastEventAt: null,
      lastError: null,
    } as const;
    const whatsappAccounts = await Promise.all(
      enabledWhatsAppAccounts.map(async (account) => {
        const rt =
          runtime.whatsappAccounts?.[account.accountId] ??
          defaultWhatsAppStatus;
        return {
          accountId: account.accountId,
          enabled: account.enabled,
          linked: await webAuthExists(account.authDir),
          authAgeMs: getWebAuthAgeMs(account.authDir),
          self: readWebSelfId(account.authDir),
          running: rt.running,
          connected: rt.connected,
          lastConnectedAt: rt.lastConnectedAt ?? null,
          lastDisconnect: rt.lastDisconnect ?? null,
          reconnectAttempts: rt.reconnectAttempts,
          lastMessageAt: rt.lastMessageAt ?? null,
          lastEventAt: rt.lastEventAt ?? null,
          lastError: rt.lastError ?? null,
        };
      }),
    );

    respond(
      true,
      {
        ts: Date.now(),
        whatsapp: {
          configured: linked,
          linked,
          authAgeMs,
          self,
          running: runtime.whatsapp.running,
          connected: runtime.whatsapp.connected,
          lastConnectedAt: runtime.whatsapp.lastConnectedAt ?? null,
          lastDisconnect: runtime.whatsapp.lastDisconnect ?? null,
          reconnectAttempts: runtime.whatsapp.reconnectAttempts,
          lastMessageAt: runtime.whatsapp.lastMessageAt ?? null,
          lastEventAt: runtime.whatsapp.lastEventAt ?? null,
          lastError: runtime.whatsapp.lastError ?? null,
        },
        whatsappAccounts,
        whatsappDefaultAccountId: defaultWhatsAppAccountId,
        telegram: {
          configured: telegramEnabled && Boolean(telegramToken),
          tokenSource,
          running: runtime.telegram.running,
          mode: runtime.telegram.mode ?? null,
          lastStartAt: runtime.telegram.lastStartAt ?? null,
          lastStopAt: runtime.telegram.lastStopAt ?? null,
          lastError: runtime.telegram.lastError ?? null,
          probe: telegramProbe,
          lastProbeAt,
        },
        discord: {
          configured: discordEnabled && Boolean(discordToken),
          tokenSource: discordTokenSource,
          running: runtime.discord.running,
          lastStartAt: runtime.discord.lastStartAt ?? null,
          lastStopAt: runtime.discord.lastStopAt ?? null,
          lastError: runtime.discord.lastError ?? null,
          probe: discordProbe,
          lastProbeAt: discordLastProbeAt,
        },
        slack: {
          configured: slackConfigured,
          botTokenSource: slackBotTokenSource,
          appTokenSource: slackAppTokenSource,
          running: runtime.slack.running,
          lastStartAt: runtime.slack.lastStartAt ?? null,
          lastStopAt: runtime.slack.lastStopAt ?? null,
          lastError: runtime.slack.lastError ?? null,
          probe: slackProbe,
          lastProbeAt: slackLastProbeAt,
        },
        signal: {
          configured: signalConfigured,
          baseUrl: signalBaseUrl,
          running: runtime.signal.running,
          lastStartAt: runtime.signal.lastStartAt ?? null,
          lastStopAt: runtime.signal.lastStopAt ?? null,
          lastError: runtime.signal.lastError ?? null,
          probe: signalProbe,
          lastProbeAt: signalLastProbeAt,
        },
        imessage: {
          configured: imessageConfigured,
          running: runtime.imessage.running,
          lastStartAt: runtime.imessage.lastStartAt ?? null,
          lastStopAt: runtime.imessage.lastStopAt ?? null,
          lastError: runtime.imessage.lastError ?? null,
          cliPath: runtime.imessage.cliPath ?? null,
          dbPath: runtime.imessage.dbPath ?? null,
          probe: imessageProbe,
          lastProbeAt: imessageLastProbeAt,
        },
      },
      undefined,
    );
  },
  "telegram.logout": async ({ respond, context }) => {
    try {
      await context.stopTelegramProvider();
      const snapshot = await readConfigFileSnapshot();
      if (!snapshot.valid) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "config invalid; fix it before logging out",
          ),
        );
        return;
      }
      const cfg = snapshot.config ?? {};
      const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
      const hadToken = Boolean(cfg.telegram?.botToken);
      const nextTelegram = cfg.telegram ? { ...cfg.telegram } : undefined;
      if (nextTelegram) {
        delete nextTelegram.botToken;
      }
      const nextCfg = { ...cfg } as ClawdbotConfig;
      if (nextTelegram && Object.keys(nextTelegram).length > 0) {
        nextCfg.telegram = nextTelegram;
      } else {
        delete nextCfg.telegram;
      }
      await writeConfigFile(nextCfg);
      respond(
        true,
        { cleared: hadToken, envToken: Boolean(envToken) },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
};

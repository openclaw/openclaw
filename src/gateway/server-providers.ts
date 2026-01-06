import type { ClawdbotConfig } from "../config/config.js";
import { monitorDiscordProvider } from "../discord/index.js";
import { probeDiscord } from "../discord/probe.js";
import { shouldLogVerbose } from "../globals.js";
import { monitorIMessageProvider } from "../imessage/index.js";
import type { createSubsystemLogger } from "../logging.js";
import { monitorWebProvider, webAuthExists } from "../providers/web/index.js";
import type { RuntimeEnv } from "../runtime.js";
import { monitorSignalProvider } from "../signal/index.js";
import {
  monitorSlackProvider,
  resolveSlackAppToken,
  resolveSlackBotToken,
} from "../slack/index.js";
import { monitorTelegramProvider } from "../telegram/monitor.js";
import { probeTelegram } from "../telegram/probe.js";
import { resolveTelegramToken } from "../telegram/token.js";
import {
  listEnabledWhatsAppAccounts,
  resolveDefaultWhatsAppAccountId,
} from "../web/accounts.js";
import type { WebProviderStatus } from "../web/auto-reply.js";
import { readWebSelfId } from "../web/session.js";
import { formatError } from "./server-utils.js";

export type TelegramRuntimeStatus = {
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  mode?: "webhook" | "polling" | null;
};

export type DiscordRuntimeStatus = {
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
};

export type SlackRuntimeStatus = {
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
};

export type SignalRuntimeStatus = {
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  baseUrl?: string | null;
};

export type IMessageRuntimeStatus = {
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  cliPath?: string | null;
  dbPath?: string | null;
};

export type ProviderRuntimeSnapshot = {
  whatsapp: WebProviderStatus;
  whatsappAccounts?: Record<string, WebProviderStatus>;
  telegram: TelegramRuntimeStatus;
  discord: DiscordRuntimeStatus;
  slack: SlackRuntimeStatus;
  signal: SignalRuntimeStatus;
  imessage: IMessageRuntimeStatus;
};

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ProviderManagerOptions = {
  loadConfig: () => ClawdbotConfig;
  logWhatsApp: SubsystemLogger;
  logTelegram: SubsystemLogger;
  logDiscord: SubsystemLogger;
  logSlack: SubsystemLogger;
  logSignal: SubsystemLogger;
  logIMessage: SubsystemLogger;
  whatsappRuntimeEnv: RuntimeEnv;
  telegramRuntimeEnv: RuntimeEnv;
  discordRuntimeEnv: RuntimeEnv;
  slackRuntimeEnv: RuntimeEnv;
  signalRuntimeEnv: RuntimeEnv;
  imessageRuntimeEnv: RuntimeEnv;
};

export type ProviderManager = {
  getRuntimeSnapshot: () => ProviderRuntimeSnapshot;
  startProviders: () => Promise<void>;
  startWhatsAppProvider: (accountId?: string) => Promise<void>;
  stopWhatsAppProvider: (accountId?: string) => Promise<void>;
  startTelegramProvider: () => Promise<void>;
  stopTelegramProvider: () => Promise<void>;
  startDiscordProvider: () => Promise<void>;
  stopDiscordProvider: () => Promise<void>;
  startSlackProvider: () => Promise<void>;
  stopSlackProvider: () => Promise<void>;
  startSignalProvider: () => Promise<void>;
  stopSignalProvider: () => Promise<void>;
  startIMessageProvider: () => Promise<void>;
  stopIMessageProvider: () => Promise<void>;
  markWhatsAppLoggedOut: (cleared: boolean, accountId?: string) => void;
};

export function createProviderManager(
  opts: ProviderManagerOptions,
): ProviderManager {
  const {
    loadConfig,
    logWhatsApp,
    logTelegram,
    logDiscord,
    logSlack,
    logSignal,
    logIMessage,
    whatsappRuntimeEnv,
    telegramRuntimeEnv,
    discordRuntimeEnv,
    slackRuntimeEnv,
    signalRuntimeEnv,
    imessageRuntimeEnv,
  } = opts;

  const whatsappAborts = new Map<string, AbortController>();
  let telegramAbort: AbortController | null = null;
  let discordAbort: AbortController | null = null;
  let slackAbort: AbortController | null = null;
  let signalAbort: AbortController | null = null;
  let imessageAbort: AbortController | null = null;
  const whatsappTasks = new Map<string, Promise<unknown>>();
  let telegramTask: Promise<unknown> | null = null;
  let discordTask: Promise<unknown> | null = null;
  let slackTask: Promise<unknown> | null = null;
  let signalTask: Promise<unknown> | null = null;
  let imessageTask: Promise<unknown> | null = null;

  const whatsappRuntimes = new Map<string, WebProviderStatus>();
  const defaultWhatsAppStatus = (): WebProviderStatus => ({
    running: false,
    connected: false,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    lastDisconnect: null,
    lastMessageAt: null,
    lastEventAt: null,
    lastError: null,
  });
  let telegramRuntime: TelegramRuntimeStatus = {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    mode: null,
  };
  let discordRuntime: DiscordRuntimeStatus = {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  let slackRuntime: SlackRuntimeStatus = {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  let signalRuntime: SignalRuntimeStatus = {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    baseUrl: null,
  };
  let imessageRuntime: IMessageRuntimeStatus = {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    cliPath: null,
    dbPath: null,
  };

  const updateWhatsAppStatus = (accountId: string, next: WebProviderStatus) => {
    whatsappRuntimes.set(accountId, next);
  };

  const startWhatsAppProvider = async (accountId?: string) => {
    const cfg = loadConfig();
    const enabledAccounts = listEnabledWhatsAppAccounts(cfg);
    const targets = accountId
      ? enabledAccounts.filter((a) => a.accountId === accountId)
      : enabledAccounts;
    if (targets.length === 0) return;

    if (cfg.web?.enabled === false) {
      for (const account of targets) {
        const current =
          whatsappRuntimes.get(account.accountId) ?? defaultWhatsAppStatus();
        whatsappRuntimes.set(account.accountId, {
          ...current,
          running: false,
          connected: false,
          lastError: "disabled",
        });
      }
      logWhatsApp.info("skipping provider start (web.enabled=false)");
      return;
    }

    await Promise.all(
      targets.map(async (account) => {
        if (whatsappTasks.has(account.accountId)) return;
        const current =
          whatsappRuntimes.get(account.accountId) ?? defaultWhatsAppStatus();
        if (!(await webAuthExists(account.authDir))) {
          whatsappRuntimes.set(account.accountId, {
            ...current,
            running: false,
            connected: false,
            lastError: "not linked",
          });
          logWhatsApp.info(
            `[${account.accountId}] skipping provider start (no linked session)`,
          );
          return;
        }

        const { e164, jid } = readWebSelfId(account.authDir);
        const identity = e164 ? e164 : jid ? `jid ${jid}` : "unknown";
        logWhatsApp.info(
          `[${account.accountId}] starting provider (${identity})`,
        );
        const abort = new AbortController();
        whatsappAborts.set(account.accountId, abort);
        whatsappRuntimes.set(account.accountId, {
          ...current,
          running: true,
          connected: false,
          lastError: null,
        });

        const task = monitorWebProvider(
          shouldLogVerbose(),
          undefined,
          true,
          undefined,
          whatsappRuntimeEnv,
          abort.signal,
          {
            statusSink: (next) => updateWhatsAppStatus(account.accountId, next),
            accountId: account.accountId,
          },
        )
          .catch((err) => {
            const latest =
              whatsappRuntimes.get(account.accountId) ??
              defaultWhatsAppStatus();
            whatsappRuntimes.set(account.accountId, {
              ...latest,
              lastError: formatError(err),
            });
            logWhatsApp.error(
              `[${account.accountId}] provider exited: ${formatError(err)}`,
            );
          })
          .finally(() => {
            whatsappAborts.delete(account.accountId);
            whatsappTasks.delete(account.accountId);
            const latest =
              whatsappRuntimes.get(account.accountId) ??
              defaultWhatsAppStatus();
            whatsappRuntimes.set(account.accountId, {
              ...latest,
              running: false,
              connected: false,
            });
          });

        whatsappTasks.set(account.accountId, task);
      }),
    );
  };

  const stopWhatsAppProvider = async (accountId?: string) => {
    const ids = accountId
      ? [accountId]
      : Array.from(
          new Set([...whatsappAborts.keys(), ...whatsappTasks.keys()]),
        );
    await Promise.all(
      ids.map(async (id) => {
        const abort = whatsappAborts.get(id);
        const task = whatsappTasks.get(id);
        if (!abort && !task) return;
        abort?.abort();
        try {
          await task;
        } catch {
          // ignore
        }
        whatsappAborts.delete(id);
        whatsappTasks.delete(id);
        const latest = whatsappRuntimes.get(id) ?? defaultWhatsAppStatus();
        whatsappRuntimes.set(id, {
          ...latest,
          running: false,
          connected: false,
        });
      }),
    );
  };

  const startTelegramProvider = async () => {
    if (telegramTask) return;
    const cfg = loadConfig();
    if (cfg.telegram?.enabled === false) {
      telegramRuntime = {
        ...telegramRuntime,
        running: false,
        lastError: "disabled",
      };
      if (shouldLogVerbose()) {
        logTelegram.debug(
          "telegram provider disabled (telegram.enabled=false)",
        );
      }
      return;
    }
    const { token: telegramToken } = resolveTelegramToken(cfg, {
      logMissingFile: (message) => logTelegram.warn(message),
    });
    if (!telegramToken.trim()) {
      telegramRuntime = {
        ...telegramRuntime,
        running: false,
        lastError: "not configured",
      };
      // keep quiet by default; this is a normal state
      if (shouldLogVerbose()) {
        logTelegram.debug(
          "telegram provider not configured (no TELEGRAM_BOT_TOKEN)",
        );
      }
      return;
    }
    let telegramBotLabel = "";
    try {
      const probe = await probeTelegram(
        telegramToken.trim(),
        2500,
        cfg.telegram?.proxy,
      );
      const username = probe.ok ? probe.bot?.username?.trim() : null;
      if (username) telegramBotLabel = ` (@${username})`;
    } catch (err) {
      if (shouldLogVerbose()) {
        logTelegram.debug(`bot probe failed: ${String(err)}`);
      }
    }
    logTelegram.info(
      `starting provider${telegramBotLabel}${cfg.telegram ? "" : " (no telegram config; token via env)"}`,
    );
    telegramAbort = new AbortController();
    telegramRuntime = {
      ...telegramRuntime,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
      mode: cfg.telegram?.webhookUrl ? "webhook" : "polling",
    };
    const task = monitorTelegramProvider({
      token: telegramToken.trim(),
      runtime: telegramRuntimeEnv,
      abortSignal: telegramAbort.signal,
      useWebhook: Boolean(cfg.telegram?.webhookUrl),
      webhookUrl: cfg.telegram?.webhookUrl,
      webhookSecret: cfg.telegram?.webhookSecret,
      webhookPath: cfg.telegram?.webhookPath,
    })
      .catch((err) => {
        telegramRuntime = {
          ...telegramRuntime,
          lastError: formatError(err),
        };
        logTelegram.error(`provider exited: ${formatError(err)}`);
      })
      .finally(() => {
        telegramAbort = null;
        telegramTask = null;
        telegramRuntime = {
          ...telegramRuntime,
          running: false,
          lastStopAt: Date.now(),
        };
      });
    telegramTask = task;
  };

  const stopTelegramProvider = async () => {
    if (!telegramAbort && !telegramTask) return;
    telegramAbort?.abort();
    try {
      await telegramTask;
    } catch {
      // ignore
    }
    telegramAbort = null;
    telegramTask = null;
    telegramRuntime = {
      ...telegramRuntime,
      running: false,
      lastStopAt: Date.now(),
    };
  };

  const startDiscordProvider = async () => {
    if (discordTask) return;
    const cfg = loadConfig();
    if (cfg.discord?.enabled === false) {
      discordRuntime = {
        ...discordRuntime,
        running: false,
        lastError: "disabled",
      };
      if (shouldLogVerbose()) {
        logDiscord.debug("discord provider disabled (discord.enabled=false)");
      }
      return;
    }
    const discordToken =
      process.env.DISCORD_BOT_TOKEN ?? cfg.discord?.token ?? "";
    if (!discordToken.trim()) {
      discordRuntime = {
        ...discordRuntime,
        running: false,
        lastError: "not configured",
      };
      // keep quiet by default; this is a normal state
      if (shouldLogVerbose()) {
        logDiscord.debug(
          "discord provider not configured (no DISCORD_BOT_TOKEN)",
        );
      }
      return;
    }
    let discordBotLabel = "";
    try {
      const probe = await probeDiscord(discordToken.trim(), 2500);
      const username = probe.ok ? probe.bot?.username?.trim() : null;
      if (username) discordBotLabel = ` (@${username})`;
    } catch (err) {
      if (shouldLogVerbose()) {
        logDiscord.debug(`bot probe failed: ${String(err)}`);
      }
    }
    logDiscord.info(
      `starting provider${discordBotLabel}${cfg.discord ? "" : " (no discord config; token via env)"}`,
    );
    discordAbort = new AbortController();
    discordRuntime = {
      ...discordRuntime,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
    };
    const task = monitorDiscordProvider({
      token: discordToken.trim(),
      runtime: discordRuntimeEnv,
      abortSignal: discordAbort.signal,
      mediaMaxMb: cfg.discord?.mediaMaxMb,
      historyLimit: cfg.discord?.historyLimit,
    })
      .catch((err) => {
        discordRuntime = {
          ...discordRuntime,
          lastError: formatError(err),
        };
        logDiscord.error(`provider exited: ${formatError(err)}`);
      })
      .finally(() => {
        discordAbort = null;
        discordTask = null;
        discordRuntime = {
          ...discordRuntime,
          running: false,
          lastStopAt: Date.now(),
        };
      });
    discordTask = task;
  };

  const stopDiscordProvider = async () => {
    if (!discordAbort && !discordTask) return;
    discordAbort?.abort();
    try {
      await discordTask;
    } catch {
      // ignore
    }
    discordAbort = null;
    discordTask = null;
    discordRuntime = {
      ...discordRuntime,
      running: false,
      lastStopAt: Date.now(),
    };
  };

  const startSlackProvider = async () => {
    if (slackTask) return;
    const cfg = loadConfig();
    if (cfg.slack?.enabled === false) {
      slackRuntime = {
        ...slackRuntime,
        running: false,
        lastError: "disabled",
      };
      if (shouldLogVerbose()) {
        logSlack.debug("slack provider disabled (slack.enabled=false)");
      }
      return;
    }
    const botToken = resolveSlackBotToken(
      process.env.SLACK_BOT_TOKEN ?? cfg.slack?.botToken ?? undefined,
    );
    const appToken = resolveSlackAppToken(
      process.env.SLACK_APP_TOKEN ?? cfg.slack?.appToken ?? undefined,
    );
    if (!botToken || !appToken) {
      slackRuntime = {
        ...slackRuntime,
        running: false,
        lastError: "not configured",
      };
      if (shouldLogVerbose()) {
        logSlack.debug(
          "slack provider not configured (missing SLACK_BOT_TOKEN/SLACK_APP_TOKEN)",
        );
      }
      return;
    }
    logSlack.info(
      `starting provider${cfg.slack ? "" : " (no slack config; tokens via env)"}`,
    );
    slackAbort = new AbortController();
    slackRuntime = {
      ...slackRuntime,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
    };
    const task = monitorSlackProvider({
      botToken,
      appToken,
      runtime: slackRuntimeEnv,
      abortSignal: slackAbort.signal,
      mediaMaxMb: cfg.slack?.mediaMaxMb,
      slashCommand: cfg.slack?.slashCommand,
    })
      .catch((err) => {
        slackRuntime = {
          ...slackRuntime,
          lastError: formatError(err),
        };
        logSlack.error(`provider exited: ${formatError(err)}`);
      })
      .finally(() => {
        slackAbort = null;
        slackTask = null;
        slackRuntime = {
          ...slackRuntime,
          running: false,
          lastStopAt: Date.now(),
        };
      });
    slackTask = task;
  };

  const stopSlackProvider = async () => {
    if (!slackAbort && !slackTask) return;
    slackAbort?.abort();
    try {
      await slackTask;
    } catch {
      // ignore
    }
    slackAbort = null;
    slackTask = null;
    slackRuntime = {
      ...slackRuntime,
      running: false,
      lastStopAt: Date.now(),
    };
  };

  const startSignalProvider = async () => {
    if (signalTask) return;
    const cfg = loadConfig();
    if (!cfg.signal) {
      signalRuntime = {
        ...signalRuntime,
        running: false,
        lastError: "not configured",
      };
      // keep quiet by default; this is a normal state
      if (shouldLogVerbose()) {
        logSignal.debug("signal provider not configured (no signal config)");
      }
      return;
    }
    if (cfg.signal?.enabled === false) {
      signalRuntime = {
        ...signalRuntime,
        running: false,
        lastError: "disabled",
      };
      if (shouldLogVerbose()) {
        logSignal.debug("signal provider disabled (signal.enabled=false)");
      }
      return;
    }
    const signalCfg = cfg.signal;
    const signalMeaningfullyConfigured = Boolean(
      signalCfg.account?.trim() ||
        signalCfg.httpUrl?.trim() ||
        signalCfg.cliPath?.trim() ||
        signalCfg.httpHost?.trim() ||
        typeof signalCfg.httpPort === "number" ||
        typeof signalCfg.autoStart === "boolean",
    );
    if (!signalMeaningfullyConfigured) {
      signalRuntime = {
        ...signalRuntime,
        running: false,
        lastError: "not configured",
      };
      // keep quiet by default; this is a normal state
      if (shouldLogVerbose()) {
        logSignal.debug(
          "signal provider not configured (signal config present but missing required fields)",
        );
      }
      return;
    }
    const host = cfg.signal?.httpHost?.trim() || "127.0.0.1";
    const port = cfg.signal?.httpPort ?? 8080;
    const baseUrl = cfg.signal?.httpUrl?.trim() || `http://${host}:${port}`;
    logSignal.info(`starting provider (${baseUrl})`);
    signalAbort = new AbortController();
    signalRuntime = {
      ...signalRuntime,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
      baseUrl,
    };
    const task = monitorSignalProvider({
      baseUrl,
      account: cfg.signal?.account,
      cliPath: cfg.signal?.cliPath,
      httpHost: cfg.signal?.httpHost,
      httpPort: cfg.signal?.httpPort,
      autoStart:
        typeof cfg.signal?.autoStart === "boolean"
          ? cfg.signal.autoStart
          : undefined,
      runtime: signalRuntimeEnv,
      abortSignal: signalAbort.signal,
    })
      .catch((err) => {
        signalRuntime = {
          ...signalRuntime,
          lastError: formatError(err),
        };
        logSignal.error(`provider exited: ${formatError(err)}`);
      })
      .finally(() => {
        signalAbort = null;
        signalTask = null;
        signalRuntime = {
          ...signalRuntime,
          running: false,
          lastStopAt: Date.now(),
        };
      });
    signalTask = task;
  };

  const stopSignalProvider = async () => {
    if (!signalAbort && !signalTask) return;
    signalAbort?.abort();
    try {
      await signalTask;
    } catch {
      // ignore
    }
    signalAbort = null;
    signalTask = null;
    signalRuntime = {
      ...signalRuntime,
      running: false,
      lastStopAt: Date.now(),
    };
  };

  const startIMessageProvider = async () => {
    if (imessageTask) return;
    const cfg = loadConfig();
    if (!cfg.imessage) {
      imessageRuntime = {
        ...imessageRuntime,
        running: false,
        lastError: "not configured",
      };
      // keep quiet by default; this is a normal state
      if (shouldLogVerbose()) {
        logIMessage.debug(
          "imessage provider not configured (no imessage config)",
        );
      }
      return;
    }
    if (cfg.imessage?.enabled === false) {
      imessageRuntime = {
        ...imessageRuntime,
        running: false,
        lastError: "disabled",
      };
      if (shouldLogVerbose()) {
        logIMessage.debug(
          "imessage provider disabled (imessage.enabled=false)",
        );
      }
      return;
    }
    const cliPath = cfg.imessage?.cliPath?.trim() || "imsg";
    const dbPath = cfg.imessage?.dbPath?.trim();
    logIMessage.info(
      `starting provider (${cliPath}${dbPath ? ` db=${dbPath}` : ""})`,
    );
    imessageAbort = new AbortController();
    imessageRuntime = {
      ...imessageRuntime,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
      cliPath,
      dbPath: dbPath ?? null,
    };
    const task = monitorIMessageProvider({
      cliPath,
      dbPath,
      allowFrom: cfg.imessage?.allowFrom,
      includeAttachments: cfg.imessage?.includeAttachments,
      mediaMaxMb: cfg.imessage?.mediaMaxMb,
      runtime: imessageRuntimeEnv,
      abortSignal: imessageAbort.signal,
    })
      .catch((err) => {
        imessageRuntime = {
          ...imessageRuntime,
          lastError: formatError(err),
        };
        logIMessage.error(`provider exited: ${formatError(err)}`);
      })
      .finally(() => {
        imessageAbort = null;
        imessageTask = null;
        imessageRuntime = {
          ...imessageRuntime,
          running: false,
          lastStopAt: Date.now(),
        };
      });
    imessageTask = task;
  };

  const stopIMessageProvider = async () => {
    if (!imessageAbort && !imessageTask) return;
    imessageAbort?.abort();
    try {
      await imessageTask;
    } catch {
      // ignore
    }
    imessageAbort = null;
    imessageTask = null;
    imessageRuntime = {
      ...imessageRuntime,
      running: false,
      lastStopAt: Date.now(),
    };
  };

  const startProviders = async () => {
    await startWhatsAppProvider();
    await startDiscordProvider();
    await startSlackProvider();
    await startTelegramProvider();
    await startSignalProvider();
    await startIMessageProvider();
  };

  const markWhatsAppLoggedOut = (cleared: boolean, accountId?: string) => {
    const cfg = loadConfig();
    const resolvedId = accountId ?? resolveDefaultWhatsAppAccountId(cfg);
    const current = whatsappRuntimes.get(resolvedId) ?? defaultWhatsAppStatus();
    whatsappRuntimes.set(resolvedId, {
      ...current,
      running: false,
      connected: false,
      lastError: cleared ? "logged out" : current.lastError,
    });
  };

  const getRuntimeSnapshot = (): ProviderRuntimeSnapshot => {
    const cfg = loadConfig();
    const defaultId = resolveDefaultWhatsAppAccountId(cfg);
    const whatsapp = whatsappRuntimes.get(defaultId) ?? defaultWhatsAppStatus();
    const whatsappAccounts = Object.fromEntries(
      Array.from(whatsappRuntimes.entries()).map(([id, status]) => [
        id,
        { ...status },
      ]),
    );
    return {
      whatsapp: { ...whatsapp },
      whatsappAccounts,
      telegram: { ...telegramRuntime },
      discord: { ...discordRuntime },
      slack: { ...slackRuntime },
      signal: { ...signalRuntime },
      imessage: { ...imessageRuntime },
    };
  };

  return {
    getRuntimeSnapshot,
    startProviders,
    startWhatsAppProvider,
    stopWhatsAppProvider,
    startTelegramProvider,
    stopTelegramProvider,
    startDiscordProvider,
    stopDiscordProvider,
    startSlackProvider,
    stopSlackProvider,
    startSignalProvider,
    stopSignalProvider,
    startIMessageProvider,
    stopIMessageProvider,
    markWhatsAppLoggedOut,
  };
}

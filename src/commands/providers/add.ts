import { type ClawdbotConfig, writeConfigFile } from "../../config/config.js";
import {
  type ChatProviderId,
  normalizeChatProviderId,
} from "../../providers/registry.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { setupProviders } from "../onboard-providers.js";
import type { ProviderChoice } from "../onboard-types.js";
import {
  providerLabel,
  requireValidConfig,
  shouldUseWizard,
} from "./shared.js";

type ChatProvider = ChatProviderId;

export type ProvidersAddOptions = {
  provider?: string;
  account?: string;
  name?: string;
  token?: string;
  tokenFile?: string;
  botToken?: string;
  appToken?: string;
  signalNumber?: string;
  cliPath?: string;
  dbPath?: string;
  service?: "imessage" | "sms" | "auto";
  region?: string;
  authDir?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
  useEnv?: boolean;
};

function providerHasAccounts(cfg: ClawdbotConfig, provider: ChatProvider) {
  if (provider === "whatsapp") return true;
  const base = (cfg as Record<string, unknown>)[provider] as
    | { accounts?: Record<string, unknown> }
    | undefined;
  return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}

function shouldStoreNameInAccounts(
  cfg: ClawdbotConfig,
  provider: ChatProvider,
  accountId: string,
): boolean {
  if (provider === "whatsapp") return true;
  if (accountId !== DEFAULT_ACCOUNT_ID) return true;
  return providerHasAccounts(cfg, provider);
}

function migrateBaseNameToDefaultAccount(
  cfg: ClawdbotConfig,
  provider: ChatProvider,
): ClawdbotConfig {
  if (provider === "whatsapp") return cfg;
  const base = (cfg as Record<string, unknown>)[provider] as
    | { name?: string; accounts?: Record<string, Record<string, unknown>> }
    | undefined;
  const baseName = base?.name?.trim();
  if (!baseName) return cfg;
  const accounts: Record<string, Record<string, unknown>> = {
    ...base?.accounts,
  };
  const defaultAccount = accounts[DEFAULT_ACCOUNT_ID] ?? {};
  if (!defaultAccount.name) {
    accounts[DEFAULT_ACCOUNT_ID] = { ...defaultAccount, name: baseName };
  }
  const { name: _ignored, ...rest } = base ?? {};
  return {
    ...cfg,
    [provider]: {
      ...rest,
      accounts,
    },
  } as ClawdbotConfig;
}

function applyAccountName(params: {
  cfg: ClawdbotConfig;
  provider: ChatProvider;
  accountId: string;
  name?: string;
}): ClawdbotConfig {
  const trimmed = params.name?.trim();
  if (!trimmed) return params.cfg;
  const accountId = normalizeAccountId(params.accountId);
  if (params.provider === "whatsapp") {
    return {
      ...params.cfg,
      whatsapp: {
        ...params.cfg.whatsapp,
        accounts: {
          ...params.cfg.whatsapp?.accounts,
          [accountId]: {
            ...params.cfg.whatsapp?.accounts?.[accountId],
            name: trimmed,
          },
        },
      },
    };
  }
  const key = params.provider;
  const useAccounts = shouldStoreNameInAccounts(params.cfg, key, accountId);
  if (!useAccounts && accountId === DEFAULT_ACCOUNT_ID) {
    const baseConfig = (params.cfg as Record<string, unknown>)[key];
    const safeBase =
      typeof baseConfig === "object" && baseConfig
        ? (baseConfig as Record<string, unknown>)
        : {};
    return {
      ...params.cfg,
      [key]: {
        ...safeBase,
        name: trimmed,
      },
    } as ClawdbotConfig;
  }
  const base = (params.cfg as Record<string, unknown>)[key] as
    | { name?: string; accounts?: Record<string, Record<string, unknown>> }
    | undefined;
  const baseAccounts: Record<
    string,
    Record<string, unknown>
  > = base?.accounts ?? {};
  const existingAccount = baseAccounts[accountId] ?? {};
  const baseWithoutName =
    accountId === DEFAULT_ACCOUNT_ID
      ? (({ name: _ignored, ...rest }) => rest)(base ?? {})
      : (base ?? {});
  return {
    ...params.cfg,
    [key]: {
      ...baseWithoutName,
      accounts: {
        ...baseAccounts,
        [accountId]: {
          ...existingAccount,
          name: trimmed,
        },
      },
    },
  } as ClawdbotConfig;
}

function applyProviderAccountConfig(params: {
  cfg: ClawdbotConfig;
  provider: ChatProvider;
  accountId: string;
  name?: string;
  token?: string;
  tokenFile?: string;
  botToken?: string;
  appToken?: string;
  signalNumber?: string;
  cliPath?: string;
  dbPath?: string;
  service?: "imessage" | "sms" | "auto";
  region?: string;
  authDir?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
  useEnv?: boolean;
}): ClawdbotConfig {
  const accountId = normalizeAccountId(params.accountId);
  const name = params.name?.trim() || undefined;
  const namedConfig = applyAccountName({
    cfg: params.cfg,
    provider: params.provider,
    accountId,
    name,
  });
  const next =
    accountId !== DEFAULT_ACCOUNT_ID
      ? migrateBaseNameToDefaultAccount(namedConfig, params.provider)
      : namedConfig;

  if (params.provider === "whatsapp") {
    const entry = {
      ...next.whatsapp?.accounts?.[accountId],
      ...(params.authDir ? { authDir: params.authDir } : {}),
      enabled: true,
    };
    return {
      ...next,
      whatsapp: {
        ...next.whatsapp,
        accounts: {
          ...next.whatsapp?.accounts,
          [accountId]: entry,
        },
      },
    };
  }

  if (params.provider === "telegram") {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        telegram: {
          ...next.telegram,
          enabled: true,
          ...(params.useEnv
            ? {}
            : params.tokenFile
              ? { tokenFile: params.tokenFile }
              : params.token
                ? { botToken: params.token }
                : {}),
        },
      };
    }
    return {
      ...next,
      telegram: {
        ...next.telegram,
        enabled: true,
        accounts: {
          ...next.telegram?.accounts,
          [accountId]: {
            ...next.telegram?.accounts?.[accountId],
            enabled: true,
            ...(params.tokenFile
              ? { tokenFile: params.tokenFile }
              : params.token
                ? { botToken: params.token }
                : {}),
          },
        },
      },
    };
  }

  if (params.provider === "discord") {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        discord: {
          ...next.discord,
          enabled: true,
          ...(params.useEnv ? {} : params.token ? { token: params.token } : {}),
        },
      };
    }
    return {
      ...next,
      discord: {
        ...next.discord,
        enabled: true,
        accounts: {
          ...next.discord?.accounts,
          [accountId]: {
            ...next.discord?.accounts?.[accountId],
            enabled: true,
            ...(params.token ? { token: params.token } : {}),
          },
        },
      },
    };
  }

  if (params.provider === "slack") {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        slack: {
          ...next.slack,
          enabled: true,
          ...(params.useEnv
            ? {}
            : {
                ...(params.botToken ? { botToken: params.botToken } : {}),
                ...(params.appToken ? { appToken: params.appToken } : {}),
              }),
        },
      };
    }
    return {
      ...next,
      slack: {
        ...next.slack,
        enabled: true,
        accounts: {
          ...next.slack?.accounts,
          [accountId]: {
            ...next.slack?.accounts?.[accountId],
            enabled: true,
            ...(params.botToken ? { botToken: params.botToken } : {}),
            ...(params.appToken ? { appToken: params.appToken } : {}),
          },
        },
      },
    };
  }

  if (params.provider === "signal") {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        signal: {
          ...next.signal,
          enabled: true,
          ...(params.signalNumber ? { account: params.signalNumber } : {}),
          ...(params.cliPath ? { cliPath: params.cliPath } : {}),
          ...(params.httpUrl ? { httpUrl: params.httpUrl } : {}),
          ...(params.httpHost ? { httpHost: params.httpHost } : {}),
          ...(params.httpPort ? { httpPort: Number(params.httpPort) } : {}),
        },
      };
    }
    return {
      ...next,
      signal: {
        ...next.signal,
        enabled: true,
        accounts: {
          ...next.signal?.accounts,
          [accountId]: {
            ...next.signal?.accounts?.[accountId],
            enabled: true,
            ...(params.signalNumber ? { account: params.signalNumber } : {}),
            ...(params.cliPath ? { cliPath: params.cliPath } : {}),
            ...(params.httpUrl ? { httpUrl: params.httpUrl } : {}),
            ...(params.httpHost ? { httpHost: params.httpHost } : {}),
            ...(params.httpPort ? { httpPort: Number(params.httpPort) } : {}),
          },
        },
      },
    };
  }

  if (params.provider === "imessage") {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        imessage: {
          ...next.imessage,
          enabled: true,
          ...(params.cliPath ? { cliPath: params.cliPath } : {}),
          ...(params.dbPath ? { dbPath: params.dbPath } : {}),
          ...(params.service ? { service: params.service } : {}),
          ...(params.region ? { region: params.region } : {}),
        },
      };
    }
    return {
      ...next,
      imessage: {
        ...next.imessage,
        enabled: true,
        accounts: {
          ...next.imessage?.accounts,
          [accountId]: {
            ...next.imessage?.accounts?.[accountId],
            enabled: true,
            ...(params.cliPath ? { cliPath: params.cliPath } : {}),
            ...(params.dbPath ? { dbPath: params.dbPath } : {}),
            ...(params.service ? { service: params.service } : {}),
            ...(params.region ? { region: params.region } : {}),
          },
        },
      },
    };
  }

  return next;
}

export async function providersAddCommand(
  opts: ProvidersAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;

  const useWizard = shouldUseWizard(params);
  if (useWizard) {
    const prompter = createClackPrompter();
    let selection: ProviderChoice[] = [];
    const accountIds: Partial<Record<ProviderChoice, string>> = {};
    await prompter.intro("Provider setup");
    let nextConfig = await setupProviders(cfg, runtime, prompter, {
      allowDisable: false,
      allowSignalInstall: true,
      promptAccountIds: true,
      onSelection: (value) => {
        selection = value;
      },
      onAccountId: (provider, accountId) => {
        accountIds[provider] = accountId;
      },
    });
    if (selection.length === 0) {
      await prompter.outro("No providers selected.");
      return;
    }

    const wantsNames = await prompter.confirm({
      message: "Add display names for these accounts? (optional)",
      initialValue: false,
    });
    if (wantsNames) {
      for (const provider of selection) {
        const accountId = accountIds[provider] ?? DEFAULT_ACCOUNT_ID;
        const existingName =
          provider === "whatsapp"
            ? nextConfig.whatsapp?.accounts?.[accountId]?.name
            : provider === "telegram"
              ? (nextConfig.telegram?.accounts?.[accountId]?.name ??
                nextConfig.telegram?.name)
              : provider === "discord"
                ? (nextConfig.discord?.accounts?.[accountId]?.name ??
                  nextConfig.discord?.name)
                : provider === "slack"
                  ? (nextConfig.slack?.accounts?.[accountId]?.name ??
                    nextConfig.slack?.name)
                  : provider === "signal"
                    ? (nextConfig.signal?.accounts?.[accountId]?.name ??
                      nextConfig.signal?.name)
                    : provider === "imessage"
                      ? (nextConfig.imessage?.accounts?.[accountId]?.name ??
                        nextConfig.imessage?.name)
                      : undefined;
        const name = await prompter.text({
          message: `${provider} account name (${accountId})`,
          initialValue: existingName,
        });
        if (name?.trim()) {
          nextConfig = applyAccountName({
            cfg: nextConfig,
            provider,
            accountId,
            name,
          });
        }
      }
    }

    await writeConfigFile(nextConfig);
    await prompter.outro("Providers updated.");
    return;
  }

  const provider = normalizeChatProviderId(opts.provider);
  if (!provider) {
    runtime.error(`Unknown provider: ${String(opts.provider ?? "")}`);
    runtime.exit(1);
    return;
  }

  const accountId = normalizeAccountId(opts.account);
  const useEnv = opts.useEnv === true;

  if (provider === "telegram") {
    if (useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      runtime.error(
        "TELEGRAM_BOT_TOKEN can only be used for the default account.",
      );
      runtime.exit(1);
      return;
    }
    if (!useEnv && !opts.token && !opts.tokenFile) {
      runtime.error(
        "Telegram requires --token or --token-file (or --use-env).",
      );
      runtime.exit(1);
      return;
    }
  }
  if (provider === "discord") {
    if (useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      runtime.error(
        "DISCORD_BOT_TOKEN can only be used for the default account.",
      );
      runtime.exit(1);
      return;
    }
    if (!useEnv && !opts.token) {
      runtime.error("Discord requires --token (or --use-env).");
      runtime.exit(1);
      return;
    }
  }
  if (provider === "slack") {
    if (useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      runtime.error(
        "Slack env tokens can only be used for the default account.",
      );
      runtime.exit(1);
      return;
    }
    if (!useEnv && (!opts.botToken || !opts.appToken)) {
      runtime.error(
        "Slack requires --bot-token and --app-token (or --use-env).",
      );
      runtime.exit(1);
      return;
    }
  }
  if (provider === "signal") {
    if (
      !opts.signalNumber &&
      !opts.httpUrl &&
      !opts.httpHost &&
      !opts.httpPort &&
      !opts.cliPath
    ) {
      runtime.error(
        "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.",
      );
      runtime.exit(1);
      return;
    }
  }

  const nextConfig = applyProviderAccountConfig({
    cfg,
    provider,
    accountId,
    name: opts.name,
    token: opts.token,
    tokenFile: opts.tokenFile,
    botToken: opts.botToken,
    appToken: opts.appToken,
    signalNumber: opts.signalNumber,
    cliPath: opts.cliPath,
    dbPath: opts.dbPath,
    service: opts.service,
    region: opts.region,
    authDir: opts.authDir,
    httpUrl: opts.httpUrl,
    httpHost: opts.httpHost,
    httpPort: opts.httpPort,
    useEnv,
  });

  await writeConfigFile(nextConfig);
  runtime.log(`Added ${providerLabel(provider)} account "${accountId}".`);
}

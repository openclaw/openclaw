import type { OpenClawConfig } from "../config/config.js";
import { coerceSecretRef, resolveSecretInputRef } from "../config/types.secrets.js";
import { collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts.js";
import {
  collectSecretInputAssignment,
  hasOwnProperty,
  isChannelAccountEffectivelyEnabled,
  isEnabledFlag,
  pushAssignment,
  pushInactiveSurfaceWarning,
  pushWarning,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

type GoogleChatAccountLike = {
  serviceAccount?: unknown;
  serviceAccountRef?: unknown;
  accounts?: Record<string, unknown>;
};

type ChannelAccountEntry = {
  accountId: string;
  account: Record<string, unknown>;
  enabled: boolean;
};

type ChannelAccountSurface = {
  hasExplicitAccounts: boolean;
  channelEnabled: boolean;
  accounts: ChannelAccountEntry[];
};

function resolveChannelAccountSurface(channel: Record<string, unknown>): ChannelAccountSurface {
  const channelEnabled = isEnabledFlag(channel);
  const accounts = channel.accounts;
  if (!isRecord(accounts) || Object.keys(accounts).length === 0) {
    return {
      hasExplicitAccounts: false,
      channelEnabled,
      accounts: [{ accountId: "default", account: channel, enabled: channelEnabled }],
    };
  }
  const accountEntries: ChannelAccountEntry[] = [];
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!isRecord(account)) {
      continue;
    }
    accountEntries.push({
      accountId,
      account,
      enabled: isChannelAccountEffectivelyEnabled(channel, account),
    });
  }
  return {
    hasExplicitAccounts: true,
    channelEnabled,
    accounts: accountEntries,
  };
}

function isBaseFieldActiveForChannelSurface(
  surface: ChannelAccountSurface,
  rootKey: string,
): boolean {
  if (!surface.channelEnabled) {
    return false;
  }
  if (!surface.hasExplicitAccounts) {
    return true;
  }
  return surface.accounts.some(
    ({ account, enabled }) => enabled && !hasOwnProperty(account, rootKey),
  );
}

function normalizeSecretStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasConfiguredSecretInputValue(
  value: unknown,
  defaults: SecretDefaults | undefined,
): boolean {
  return normalizeSecretStringValue(value).length > 0 || coerceSecretRef(value, defaults) !== null;
}

function collectSimpleChannelFieldAssignments(params: {
  channelKey: string;
  field: string;
  channel: Record<string, unknown>;
  surface: ChannelAccountSurface;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  topInactiveReason: string;
  accountInactiveReason: string;
}): void {
  collectSecretInputAssignment({
    value: params.channel[params.field],
    path: `channels.${params.channelKey}.${params.field}`,
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: isBaseFieldActiveForChannelSurface(params.surface, params.field),
    inactiveReason: params.topInactiveReason,
    apply: (value) => {
      params.channel[params.field] = value;
    },
  });
  if (!params.surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of params.surface.accounts) {
    if (!hasOwnProperty(account, params.field)) {
      continue;
    }
    collectSecretInputAssignment({
      value: account[params.field],
      path: `channels.${params.channelKey}.accounts.${accountId}.${params.field}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: enabled,
      inactiveReason: params.accountInactiveReason,
      apply: (value) => {
        account[params.field] = value;
      },
    });
  }
}

function collectTelegramAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const channels = params.config.channels as Record<string, unknown> | undefined;
  if (!isRecord(channels)) {
    return;
  }
  const telegram = channels.telegram;
  if (!isRecord(telegram)) {
    return;
  }
  const surface = resolveChannelAccountSurface(telegram);
  const baseTokenFile = typeof telegram.tokenFile === "string" ? telegram.tokenFile.trim() : "";
  const topLevelBotTokenActive = !surface.channelEnabled
    ? false
    : !surface.hasExplicitAccounts
      ? baseTokenFile.length === 0
      : surface.accounts.some(({ account, enabled }) => {
          if (!enabled || baseTokenFile.length > 0) {
            return false;
          }
          const accountBotTokenConfigured = hasConfiguredSecretInputValue(
            account.botToken,
            params.defaults,
          );
          const accountTokenFileConfigured =
            typeof account.tokenFile === "string" && account.tokenFile.trim().length > 0;
          return !accountBotTokenConfigured && !accountTokenFileConfigured;
        });
  collectSecretInputAssignment({
    value: telegram.botToken,
    path: "channels.telegram.botToken",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelBotTokenActive,
    inactiveReason:
      "no enabled Telegram surface inherits this top-level botToken (tokenFile is configured).",
    apply: (value) => {
      telegram.botToken = value;
    },
  });
  if (surface.hasExplicitAccounts) {
    for (const { accountId, account, enabled } of surface.accounts) {
      if (!hasOwnProperty(account, "botToken")) {
        continue;
      }
      const accountTokenFile =
        typeof account.tokenFile === "string" ? account.tokenFile.trim() : "";
      collectSecretInputAssignment({
        value: account.botToken,
        path: `channels.telegram.accounts.${accountId}.botToken`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled && accountTokenFile.length === 0,
        inactiveReason: "Telegram account is disabled or tokenFile is configured.",
        apply: (value) => {
          account.botToken = value;
        },
      });
    }
  }
  const baseWebhookUrl = typeof telegram.webhookUrl === "string" ? telegram.webhookUrl.trim() : "";
  const topLevelWebhookSecretActive = !surface.channelEnabled
    ? false
    : !surface.hasExplicitAccounts
      ? baseWebhookUrl.length > 0
      : surface.accounts.some(
          ({ account, enabled }) =>
            enabled &&
            !hasOwnProperty(account, "webhookSecret") &&
            (hasOwnProperty(account, "webhookUrl")
              ? typeof account.webhookUrl === "string" && account.webhookUrl.trim().length > 0
              : baseWebhookUrl.length > 0),
        );
  collectSecretInputAssignment({
    value: telegram.webhookSecret,
    path: "channels.telegram.webhookSecret",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelWebhookSecretActive,
    inactiveReason:
      "no enabled Telegram webhook surface inherits this top-level webhookSecret (webhook mode is not active).",
    apply: (value) => {
      telegram.webhookSecret = value;
    },
  });
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (!hasOwnProperty(account, "webhookSecret")) {
      continue;
    }
    const accountWebhookUrl = hasOwnProperty(account, "webhookUrl")
      ? typeof account.webhookUrl === "string"
        ? account.webhookUrl.trim()
        : ""
      : baseWebhookUrl;
    collectSecretInputAssignment({
      value: account.webhookSecret,
      path: `channels.telegram.accounts.${accountId}.webhookSecret`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: enabled && accountWebhookUrl.length > 0,
      inactiveReason:
        "Telegram account is disabled or webhook mode is not active for this account.",
      apply: (value) => {
        account.webhookSecret = value;
      },
    });
  }
}

function collectSlackAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const channels = params.config.channels as Record<string, unknown> | undefined;
  if (!isRecord(channels)) {
    return;
  }
  const slack = channels.slack;
  if (!isRecord(slack)) {
    return;
  }
  const surface = resolveChannelAccountSurface(slack);
  const baseMode = slack.mode === "http" || slack.mode === "socket" ? slack.mode : "socket";
  const fields = ["botToken", "userToken"] as const;
  for (const field of fields) {
    collectSimpleChannelFieldAssignments({
      channelKey: "slack",
      field,
      channel: slack,
      surface,
      defaults: params.defaults,
      context: params.context,
      topInactiveReason: `no enabled account inherits this top-level Slack ${field}.`,
      accountInactiveReason: "Slack account is disabled.",
    });
  }
  const topLevelAppTokenActive = !surface.channelEnabled
    ? false
    : !surface.hasExplicitAccounts
      ? baseMode !== "http"
      : surface.accounts.some(({ account, enabled }) => {
          if (!enabled || hasOwnProperty(account, "appToken")) {
            return false;
          }
          const accountMode =
            account.mode === "http" || account.mode === "socket" ? account.mode : baseMode;
          return accountMode !== "http";
        });
  collectSecretInputAssignment({
    value: slack.appToken,
    path: "channels.slack.appToken",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelAppTokenActive,
    inactiveReason: "no enabled Slack socket-mode surface inherits this top-level appToken.",
    apply: (value) => {
      slack.appToken = value;
    },
  });
  const topLevelSigningSecretActive = !surface.channelEnabled
    ? false
    : !surface.hasExplicitAccounts
      ? baseMode === "http"
      : surface.accounts.some(({ account, enabled }) => {
          if (!enabled || hasOwnProperty(account, "signingSecret")) {
            return false;
          }
          const accountMode =
            account.mode === "http" || account.mode === "socket" ? account.mode : baseMode;
          return accountMode === "http";
        });
  collectSecretInputAssignment({
    value: slack.signingSecret,
    path: "channels.slack.signingSecret",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelSigningSecretActive,
    inactiveReason: "no enabled Slack HTTP-mode surface inherits this top-level signingSecret.",
    apply: (value) => {
      slack.signingSecret = value;
    },
  });
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    const accountMode =
      account.mode === "http" || account.mode === "socket" ? account.mode : baseMode;
    if (hasOwnProperty(account, "appToken")) {
      collectSecretInputAssignment({
        value: account.appToken,
        path: `channels.slack.accounts.${accountId}.appToken`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled && accountMode !== "http",
        inactiveReason: "Slack account is disabled or not running in socket mode.",
        apply: (value) => {
          account.appToken = value;
        },
      });
    }
    if (!hasOwnProperty(account, "signingSecret")) {
      continue;
    }
    collectSecretInputAssignment({
      value: account.signingSecret,
      path: `channels.slack.accounts.${accountId}.signingSecret`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: enabled && accountMode === "http",
      inactiveReason: "Slack account is disabled or not running in HTTP mode.",
      apply: (value) => {
        account.signingSecret = value;
      },
    });
  }
}

function collectDiscordAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const channels = params.config.channels as Record<string, unknown> | undefined;
  if (!isRecord(channels)) {
    return;
  }
  const discord = channels.discord;
  if (!isRecord(discord)) {
    return;
  }
  const surface = resolveChannelAccountSurface(discord);
  collectSimpleChannelFieldAssignments({
    channelKey: "discord",
    field: "token",
    channel: discord,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level Discord token.",
    accountInactiveReason: "Discord account is disabled.",
  });
  if (isRecord(discord.pluralkit)) {
    const pluralkit = discord.pluralkit;
    collectSecretInputAssignment({
      value: pluralkit.token,
      path: "channels.discord.pluralkit.token",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: isBaseFieldActiveForChannelSurface(surface, "pluralkit") && isEnabledFlag(pluralkit),
      inactiveReason:
        "no enabled Discord surface inherits this top-level PluralKit config or PluralKit is disabled.",
      apply: (value) => {
        pluralkit.token = value;
      },
    });
  }
  if (isRecord(discord.voice) && isRecord(discord.voice.tts)) {
    collectTtsApiKeyAssignments({
      tts: discord.voice.tts,
      pathPrefix: "channels.discord.voice.tts",
      defaults: params.defaults,
      context: params.context,
      active: isBaseFieldActiveForChannelSurface(surface, "voice") && isEnabledFlag(discord.voice),
      inactiveReason:
        "no enabled Discord surface inherits this top-level voice config or voice is disabled.",
    });
  }
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (hasOwnProperty(account, "pluralkit") && isRecord(account.pluralkit)) {
      const pluralkit = account.pluralkit;
      collectSecretInputAssignment({
        value: pluralkit.token,
        path: `channels.discord.accounts.${accountId}.pluralkit.token`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled && isEnabledFlag(pluralkit),
        inactiveReason: "Discord account is disabled or PluralKit is disabled for this account.",
        apply: (value) => {
          pluralkit.token = value;
        },
      });
    }
    if (
      hasOwnProperty(account, "voice") &&
      isRecord(account.voice) &&
      isRecord(account.voice.tts)
    ) {
      collectTtsApiKeyAssignments({
        tts: account.voice.tts,
        pathPrefix: `channels.discord.accounts.${accountId}.voice.tts`,
        defaults: params.defaults,
        context: params.context,
        active: enabled && isEnabledFlag(account.voice),
        inactiveReason: "Discord account is disabled or voice is disabled for this account.",
      });
    }
  }
}

function collectIrcAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const channels = params.config.channels as Record<string, unknown> | undefined;
  if (!isRecord(channels)) {
    return;
  }
  const irc = channels.irc;
  if (!isRecord(irc)) {
    return;
  }
  const surface = resolveChannelAccountSurface(irc);
  collectSimpleChannelFieldAssignments({
    channelKey: "irc",
    field: "password",
    channel: irc,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level IRC password.",
    accountInactiveReason: "IRC account is disabled.",
  });
  if (isRecord(irc.nickserv)) {
    const nickserv = irc.nickserv;
    collectSecretInputAssignment({
      value: nickserv.password,
      path: "channels.irc.nickserv.password",
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: isBaseFieldActiveForChannelSurface(surface, "nickserv") && isEnabledFlag(nickserv),
      inactiveReason:
        "no enabled account inherits this top-level IRC nickserv config or NickServ is disabled.",
      apply: (value) => {
        nickserv.password = value;
      },
    });
  }
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (hasOwnProperty(account, "nickserv") && isRecord(account.nickserv)) {
      const nickserv = account.nickserv;
      collectSecretInputAssignment({
        value: nickserv.password,
        path: `channels.irc.accounts.${accountId}.nickserv.password`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled && isEnabledFlag(nickserv),
        inactiveReason: "IRC account is disabled or NickServ is disabled for this account.",
        apply: (value) => {
          nickserv.password = value;
        },
      });
    }
  }
}

function collectBlueBubblesAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const channels = params.config.channels as Record<string, unknown> | undefined;
  if (!isRecord(channels)) {
    return;
  }
  const bluebubbles = channels.bluebubbles;
  if (!isRecord(bluebubbles)) {
    return;
  }
  const surface = resolveChannelAccountSurface(bluebubbles);
  collectSimpleChannelFieldAssignments({
    channelKey: "bluebubbles",
    field: "password",
    channel: bluebubbles,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level BlueBubbles password.",
    accountInactiveReason: "BlueBubbles account is disabled.",
  });
}

function collectMSTeamsAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const channels = params.config.channels as Record<string, unknown> | undefined;
  if (!isRecord(channels)) {
    return;
  }
  const msteams = channels.msteams;
  if (!isRecord(msteams)) {
    return;
  }
  collectSecretInputAssignment({
    value: msteams.appPassword,
    path: "channels.msteams.appPassword",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: msteams.enabled !== false,
    inactiveReason: "Microsoft Teams channel is disabled.",
    apply: (value) => {
      msteams.appPassword = value;
    },
  });
}

function collectMattermostAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const channels = params.config.channels as Record<string, unknown> | undefined;
  if (!isRecord(channels)) {
    return;
  }
  const mattermost = channels.mattermost;
  if (!isRecord(mattermost)) {
    return;
  }
  const surface = resolveChannelAccountSurface(mattermost);
  collectSimpleChannelFieldAssignments({
    channelKey: "mattermost",
    field: "botToken",
    channel: mattermost,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level Mattermost botToken.",
    accountInactiveReason: "Mattermost account is disabled.",
  });
}

function collectMatrixAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const channels = params.config.channels as Record<string, unknown> | undefined;
  if (!isRecord(channels)) {
    return;
  }
  const matrix = channels.matrix;
  if (!isRecord(matrix)) {
    return;
  }
  const surface = resolveChannelAccountSurface(matrix);
  const envAccessTokenConfigured =
    normalizeSecretStringValue(params.context.env.MATRIX_ACCESS_TOKEN).length > 0;
  const baseAccessTokenConfigured = hasConfiguredSecretInputValue(
    matrix.accessToken,
    params.defaults,
  );
  const topLevelPasswordActive = !surface.channelEnabled
    ? false
    : !surface.hasExplicitAccounts
      ? !(baseAccessTokenConfigured || envAccessTokenConfigured)
      : surface.accounts.some(
          ({ account, enabled }) =>
            enabled &&
            !hasOwnProperty(account, "password") &&
            !hasConfiguredSecretInputValue(account.accessToken, params.defaults) &&
            !(baseAccessTokenConfigured || envAccessTokenConfigured),
        );
  collectSecretInputAssignment({
    value: matrix.password,
    path: "channels.matrix.password",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelPasswordActive,
    inactiveReason:
      "no enabled Matrix surface inherits this top-level password (an accessToken is configured).",
    apply: (value) => {
      matrix.password = value;
    },
  });
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (!hasOwnProperty(account, "password")) {
      continue;
    }
    const accountAccessTokenConfigured = hasConfiguredSecretInputValue(
      account.accessToken,
      params.defaults,
    );
    const inheritedAccessTokenConfigured =
      !hasOwnProperty(account, "accessToken") &&
      (baseAccessTokenConfigured || envAccessTokenConfigured);
    collectSecretInputAssignment({
      value: account.password,
      path: `channels.matrix.accounts.${accountId}.password`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: enabled && !(accountAccessTokenConfigured || inheritedAccessTokenConfigured),
      inactiveReason: "Matrix account is disabled or an accessToken is configured.",
      apply: (value) => {
        account.password = value;
      },
    });
  }
}

function collectZaloAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const channels = params.config.channels as Record<string, unknown> | undefined;
  if (!isRecord(channels)) {
    return;
  }
  const zalo = channels.zalo;
  if (!isRecord(zalo)) {
    return;
  }
  const surface = resolveChannelAccountSurface(zalo);
  const topLevelBotTokenActive = !surface.channelEnabled
    ? false
    : !surface.hasExplicitAccounts
      ? true
      : surface.accounts.some(
          ({ account, enabled }) => enabled && !hasOwnProperty(account, "botToken"),
        );
  collectSecretInputAssignment({
    value: zalo.botToken,
    path: "channels.zalo.botToken",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelBotTokenActive,
    inactiveReason: "no enabled Zalo surface inherits this top-level botToken.",
    apply: (value) => {
      zalo.botToken = value;
    },
  });
  const baseWebhookUrl = normalizeSecretStringValue(zalo.webhookUrl);
  const topLevelWebhookSecretActive = !surface.channelEnabled
    ? false
    : !surface.hasExplicitAccounts
      ? baseWebhookUrl.length > 0
      : surface.accounts.some(({ account, enabled }) => {
          if (!enabled || hasOwnProperty(account, "webhookSecret")) {
            return false;
          }
          const accountWebhookUrl = hasOwnProperty(account, "webhookUrl")
            ? normalizeSecretStringValue(account.webhookUrl)
            : baseWebhookUrl;
          return accountWebhookUrl.length > 0;
        });
  collectSecretInputAssignment({
    value: zalo.webhookSecret,
    path: "channels.zalo.webhookSecret",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelWebhookSecretActive,
    inactiveReason:
      "no enabled Zalo webhook surface inherits this top-level webhookSecret (webhook mode is not active).",
    apply: (value) => {
      zalo.webhookSecret = value;
    },
  });
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (hasOwnProperty(account, "botToken")) {
      collectSecretInputAssignment({
        value: account.botToken,
        path: `channels.zalo.accounts.${accountId}.botToken`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled,
        inactiveReason: "Zalo account is disabled.",
        apply: (value) => {
          account.botToken = value;
        },
      });
    }
    if (hasOwnProperty(account, "webhookSecret")) {
      const accountWebhookUrl = hasOwnProperty(account, "webhookUrl")
        ? normalizeSecretStringValue(account.webhookUrl)
        : baseWebhookUrl;
      collectSecretInputAssignment({
        value: account.webhookSecret,
        path: `channels.zalo.accounts.${accountId}.webhookSecret`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled && accountWebhookUrl.length > 0,
        inactiveReason: "Zalo account is disabled or webhook mode is not active for this account.",
        apply: (value) => {
          account.webhookSecret = value;
        },
      });
    }
  }
}

function collectFeishuAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const channels = params.config.channels as Record<string, unknown> | undefined;
  if (!isRecord(channels)) {
    return;
  }
  const feishu = channels.feishu;
  if (!isRecord(feishu)) {
    return;
  }
  const surface = resolveChannelAccountSurface(feishu);
  collectSimpleChannelFieldAssignments({
    channelKey: "feishu",
    field: "appSecret",
    channel: feishu,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level Feishu appSecret.",
    accountInactiveReason: "Feishu account is disabled.",
  });
  const baseConnectionMode =
    normalizeSecretStringValue(feishu.connectionMode) === "webhook" ? "webhook" : "websocket";
  const topLevelVerificationTokenActive = !surface.channelEnabled
    ? false
    : !surface.hasExplicitAccounts
      ? baseConnectionMode === "webhook"
      : surface.accounts.some(({ account, enabled }) => {
          if (!enabled || hasOwnProperty(account, "verificationToken")) {
            return false;
          }
          const accountMode = hasOwnProperty(account, "connectionMode")
            ? normalizeSecretStringValue(account.connectionMode)
            : baseConnectionMode;
          return accountMode === "webhook";
        });
  collectSecretInputAssignment({
    value: feishu.verificationToken,
    path: "channels.feishu.verificationToken",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelVerificationTokenActive,
    inactiveReason:
      "no enabled Feishu webhook-mode surface inherits this top-level verificationToken.",
    apply: (value) => {
      feishu.verificationToken = value;
    },
  });
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (!hasOwnProperty(account, "verificationToken")) {
      continue;
    }
    const accountMode = hasOwnProperty(account, "connectionMode")
      ? normalizeSecretStringValue(account.connectionMode)
      : baseConnectionMode;
    collectSecretInputAssignment({
      value: account.verificationToken,
      path: `channels.feishu.accounts.${accountId}.verificationToken`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: enabled && accountMode === "webhook",
      inactiveReason: "Feishu account is disabled or not running in webhook mode.",
      apply: (value) => {
        account.verificationToken = value;
      },
    });
  }
}

function collectNextcloudTalkAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const channels = params.config.channels as Record<string, unknown> | undefined;
  if (!isRecord(channels)) {
    return;
  }
  const nextcloudTalk = channels["nextcloud-talk"];
  if (!isRecord(nextcloudTalk)) {
    return;
  }
  const surface = resolveChannelAccountSurface(nextcloudTalk);
  const topLevelBotSecretActive = !surface.channelEnabled
    ? false
    : !surface.hasExplicitAccounts
      ? true
      : surface.accounts.some(
          ({ account, enabled }) => enabled && !hasOwnProperty(account, "botSecret"),
        );
  collectSecretInputAssignment({
    value: nextcloudTalk.botSecret,
    path: "channels.nextcloud-talk.botSecret",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelBotSecretActive,
    inactiveReason: "no enabled Nextcloud Talk surface inherits this top-level botSecret.",
    apply: (value) => {
      nextcloudTalk.botSecret = value;
    },
  });
  const topLevelApiPasswordActive = !surface.channelEnabled
    ? false
    : !surface.hasExplicitAccounts
      ? true
      : surface.accounts.some(
          ({ account, enabled }) => enabled && !hasOwnProperty(account, "apiPassword"),
        );
  collectSecretInputAssignment({
    value: nextcloudTalk.apiPassword,
    path: "channels.nextcloud-talk.apiPassword",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: topLevelApiPasswordActive,
    inactiveReason: "no enabled Nextcloud Talk surface inherits this top-level apiPassword.",
    apply: (value) => {
      nextcloudTalk.apiPassword = value;
    },
  });
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (hasOwnProperty(account, "botSecret")) {
      collectSecretInputAssignment({
        value: account.botSecret,
        path: `channels.nextcloud-talk.accounts.${accountId}.botSecret`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled,
        inactiveReason: "Nextcloud Talk account is disabled.",
        apply: (value) => {
          account.botSecret = value;
        },
      });
    }
    if (hasOwnProperty(account, "apiPassword")) {
      collectSecretInputAssignment({
        value: account.apiPassword,
        path: `channels.nextcloud-talk.accounts.${accountId}.apiPassword`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: enabled,
        inactiveReason: "Nextcloud Talk account is disabled.",
        apply: (value) => {
          account.apiPassword = value;
        },
      });
    }
  }
}

function collectGoogleChatAccountAssignment(params: {
  target: GoogleChatAccountLike;
  path: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
}): void {
  const { explicitRef, ref } = resolveSecretInputRef({
    value: params.target.serviceAccount,
    refValue: params.target.serviceAccountRef,
    defaults: params.defaults,
  });
  if (!ref) {
    return;
  }
  if (params.active === false) {
    pushInactiveSurfaceWarning({
      context: params.context,
      path: `${params.path}.serviceAccount`,
      details: params.inactiveReason,
    });
    return;
  }
  if (
    explicitRef &&
    params.target.serviceAccount !== undefined &&
    !coerceSecretRef(params.target.serviceAccount, params.defaults)
  ) {
    pushWarning(params.context, {
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      path: params.path,
      message: `${params.path}: serviceAccountRef is set; runtime will ignore plaintext serviceAccount.`,
    });
  }
  pushAssignment(params.context, {
    ref,
    path: `${params.path}.serviceAccount`,
    expected: "string-or-object",
    apply: (value) => {
      params.target.serviceAccount = value;
    },
  });
}

function collectGoogleChatAssignments(params: {
  googleChat: GoogleChatAccountLike;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const googleChatRecord = params.googleChat as Record<string, unknown>;
  const surface = resolveChannelAccountSurface(googleChatRecord);
  const topLevelServiceAccountActive = !surface.channelEnabled
    ? false
    : !surface.hasExplicitAccounts
      ? true
      : surface.accounts.some(
          ({ account, enabled }) =>
            enabled &&
            !hasOwnProperty(account, "serviceAccount") &&
            !hasOwnProperty(account, "serviceAccountRef"),
        );
  collectGoogleChatAccountAssignment({
    target: params.googleChat,
    path: "channels.googlechat",
    defaults: params.defaults,
    context: params.context,
    active: topLevelServiceAccountActive,
    inactiveReason: "no enabled account inherits this top-level Google Chat serviceAccount.",
  });
  if (!surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of surface.accounts) {
    if (
      !hasOwnProperty(account, "serviceAccount") &&
      !hasOwnProperty(account, "serviceAccountRef")
    ) {
      continue;
    }
    collectGoogleChatAccountAssignment({
      target: account as GoogleChatAccountLike,
      path: `channels.googlechat.accounts.${accountId}`,
      defaults: params.defaults,
      context: params.context,
      active: enabled,
      inactiveReason: "Google Chat account is disabled.",
    });
  }
}

export function collectChannelConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const googleChat = params.config.channels?.googlechat as GoogleChatAccountLike | undefined;
  if (googleChat) {
    collectGoogleChatAssignments({
      googleChat,
      defaults: params.defaults,
      context: params.context,
    });
  }
  collectTelegramAssignments(params);
  collectSlackAssignments(params);
  collectDiscordAssignments(params);
  collectIrcAssignments(params);
  collectBlueBubblesAssignments(params);
  collectMattermostAssignments(params);
  collectMatrixAssignments(params);
  collectMSTeamsAssignments(params);
  collectNextcloudTalkAssignments(params);
  collectFeishuAssignments(params);
  collectZaloAssignments(params);
}

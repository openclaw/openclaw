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
  collectSimpleChannelFieldAssignments({
    channelKey: "telegram",
    field: "botToken",
    channel: telegram,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level Telegram botToken.",
    accountInactiveReason: "Telegram account is disabled.",
  });
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
  const fields = ["botToken", "appToken", "userToken", "signingSecret"] as const;
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
      active: isBaseFieldActiveForChannelSurface(surface, "pluralkit"),
      inactiveReason: "no enabled account inherits this top-level Discord pluralkit config.",
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
      active: isBaseFieldActiveForChannelSurface(surface, "voice"),
      inactiveReason: "no enabled account inherits this top-level Discord voice config.",
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
        active: enabled,
        inactiveReason: "Discord account is disabled.",
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
        active: enabled,
        inactiveReason: "Discord account is disabled.",
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
      active: isBaseFieldActiveForChannelSurface(surface, "nickserv"),
      inactiveReason: "no enabled account inherits this top-level IRC nickserv config.",
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
        active: enabled,
        inactiveReason: "IRC account is disabled.",
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
  collectMSTeamsAssignments(params);
}

import type { OpenClawConfig } from "../../../config/config.js";
import type { DiscordGuildEntry } from "../../../config/types.discord.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
} from "../../../discord/accounts.js";
import { normalizeDiscordSlug } from "../../../discord/monitor/allow-list.js";
import {
  resolveDiscordChannelAllowlist,
  type DiscordChannelResolution,
} from "../../../discord/resolve-channels.js";
import { resolveDiscordUserAllowlist } from "../../../discord/resolve-users.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { configureChannelAccessWithAllowlist } from "./channel-access-configure.js";
import {
  applySingleTokenPromptResult,
  parseMentionOrPrefixedId,
  noteChannelLookupFailure,
  noteChannelLookupSummary,
  patchChannelConfigForAccount,
  promptLegacyChannelAllowFrom,
  promptSingleChannelToken,
  resolveAccountIdForConfigure,
  resolveOnboardingAccountId,
  setAccountGroupPolicyForChannel,
  setLegacyChannelDmPolicyWithAllowFrom,
  setOnboardingChannelEnabled,
} from "./helpers.js";

const channel = "discord" as const;

async function noteDiscordTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Discord Developer Portal → Applications → New Application",
      "2) Bot → Add Bot → Reset Token → copy token",
      "3) OAuth2 → URL Generator → scope 'bot' → invite to your server",
      "Tip: enable Message Content Intent if you need message text. (Bot → Privileged Gateway Intents → Message Content Intent)",
      `Docs: ${formatDocsLink("/discord", "discord")}`,
    ].join("\n"),
    "Discord bot token",
  );
}

function setDiscordGuildChannelAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  entries: Array<{
    guildKey: string;
    channelKey?: string;
  }>,
): OpenClawConfig {
  const baseGuilds =
    accountId === DEFAULT_ACCOUNT_ID
      ? (cfg.channels?.discord?.guilds ?? {})
      : (cfg.channels?.discord?.accounts?.[accountId]?.guilds ?? {});
  const guilds: Record<string, DiscordGuildEntry> = { ...baseGuilds };
  for (const entry of entries) {
    const guildKey = entry.guildKey || "*";
    const existing = guilds[guildKey] ?? {};
    if (entry.channelKey) {
      const channels = { ...existing.channels };
      channels[entry.channelKey] = { allow: true };
      guilds[guildKey] = { ...existing, channels };
    } else {
      guilds[guildKey] = existing;
    }
  }
  return patchChannelConfigForAccount({
    cfg,
    channel: "discord",
    accountId,
    patch: { guilds },
  });
}

async function promptDiscordAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId = resolveOnboardingAccountId({
    accountId: params.accountId,
    defaultAccountId: resolveDefaultDiscordAccountId(params.cfg),
  });
  const resolved = resolveDiscordAccount({ cfg: params.cfg, accountId });
  const token = resolved.token;
  const existing =
    params.cfg.channels?.discord?.allowFrom ?? params.cfg.channels?.discord?.dm?.allowFrom ?? [];
  const parseId = (value: string) =>
    parseMentionOrPrefixedId({
      value,
      mentionPattern: /^<@!?(\d+)>$/,
      prefixPattern: /^(user:|discord:)/i,
      idPattern: /^\d+$/,
    });

  return promptLegacyChannelAllowFrom({
    cfg: params.cfg,
    channel: "discord",
    prompter: params.prompter,
    existing,
    token,
    noteTitle: "Discord allowlist",
    noteLines: [
      "Allowlist Discord DMs by username (we resolve to user ids).",
      "Examples:",
      "- 123456789012345678",
      "- @alice",
      "- alice#1234",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/discord", "discord")}`,
    ],
    message: "Discord allowFrom (usernames or ids)",
    placeholder: "@alice, 123456789012345678",
    parseId,
    invalidWithoutTokenNote: "Bot token missing; use numeric user ids (or mention form) only.",
    resolveEntries: ({ token, entries }) =>
      resolveDiscordUserAllowlist({
        token,
        entries,
      }),
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Discord",
  channel,
  policyKey: "channels.discord.dmPolicy",
  allowFromKey: "channels.discord.allowFrom",
  getCurrent: (cfg) =>
    cfg.channels?.discord?.dmPolicy ?? cfg.channels?.discord?.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy) =>
    setLegacyChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "discord",
      dmPolicy: policy,
    }),
  promptAllowFrom: promptDiscordAllowFrom,
};

export const discordOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listDiscordAccountIds(cfg).some((accountId) =>
      Boolean(resolveDiscordAccount({ cfg, accountId }).token),
    );
    return {
      channel,
      configured,
      statusLines: [`Discord: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured ? "configured" : "needs token",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const defaultDiscordAccountId = resolveDefaultDiscordAccountId(cfg);
    const discordAccountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "Discord",
      accountOverride: accountOverrides.discord,
      shouldPromptAccountIds,
      listAccountIds: listDiscordAccountIds,
      defaultAccountId: defaultDiscordAccountId,
    });

    let next = cfg;
    const resolvedAccount = resolveDiscordAccount({
      cfg: next,
      accountId: discordAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = discordAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv && !resolvedAccount.config.token && Boolean(process.env.DISCORD_BOT_TOKEN?.trim());
    const hasConfigToken = Boolean(resolvedAccount.config.token);

    if (!accountConfigured) {
      await noteDiscordTokenHelp(prompter);
    }

    const tokenResult = await promptSingleChannelToken({
      prompter,
      accountConfigured,
      canUseEnv,
      hasConfigToken,
      envPrompt: "DISCORD_BOT_TOKEN detected. Use env var?",
      keepPrompt: "Discord token already configured. Keep it?",
      inputPrompt: "Enter Discord bot token",
    });

    next = applySingleTokenPromptResult({
      cfg: next,
      channel: "discord",
      accountId: discordAccountId,
      tokenPatchKey: "token",
      tokenResult,
    });

    const currentEntries = Object.entries(resolvedAccount.config.guilds ?? {}).flatMap(
      ([guildKey, value]) => {
        const channels = value?.channels ?? {};
        const channelKeys = Object.keys(channels);
        if (channelKeys.length === 0) {
          const input = /^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey;
          return [input];
        }
        return channelKeys.map((channelKey) => `${guildKey}/${channelKey}`);
      },
    );
    next = await configureChannelAccessWithAllowlist({
      cfg: next,
      prompter,
      label: "Discord channels",
      currentPolicy: resolvedAccount.config.groupPolicy ?? "allowlist",
      currentEntries,
      placeholder: "My Server/#general, guildId/channelId, #support",
      updatePrompt: Boolean(resolvedAccount.config.guilds),
      setPolicy: (cfg, policy) =>
        setAccountGroupPolicyForChannel({
          cfg,
          channel: "discord",
          accountId: discordAccountId,
          groupPolicy: policy,
        }),
      resolveAllowlist: async ({ cfg, entries }) => {
        const accountWithTokens = resolveDiscordAccount({
          cfg,
          accountId: discordAccountId,
        });
        let resolved: DiscordChannelResolution[] = entries.map((input) => ({
          input,
          resolved: false,
        }));
        if (accountWithTokens.token && entries.length > 0) {
          try {
            resolved = await resolveDiscordChannelAllowlist({
              token: accountWithTokens.token,
              entries,
            });
            const resolvedChannels = resolved.filter((entry) => entry.resolved && entry.channelId);
            const resolvedGuilds = resolved.filter(
              (entry) => entry.resolved && entry.guildId && !entry.channelId,
            );
            const unresolved = resolved
              .filter((entry) => !entry.resolved)
              .map((entry) => entry.input);
            await noteChannelLookupSummary({
              prompter,
              label: "Discord channels",
              resolvedSections: [
                {
                  title: "Resolved channels",
                  values: resolvedChannels
                    .map((entry) => entry.channelId)
                    .filter((value): value is string => Boolean(value)),
                },
                {
                  title: "Resolved guilds",
                  values: resolvedGuilds
                    .map((entry) => entry.guildId)
                    .filter((value): value is string => Boolean(value)),
                },
              ],
              unresolved,
            });
          } catch (err) {
            await noteChannelLookupFailure({
              prompter,
              label: "Discord channels",
              error: err,
            });
          }
        }
        return resolved;
      },
      applyAllowlist: ({ cfg, resolved }) => {
        const allowlistEntries: Array<{ guildKey: string; channelKey?: string }> = [];
        for (const entry of resolved) {
          const guildKey =
            entry.guildId ??
            (entry.guildName ? normalizeDiscordSlug(entry.guildName) : undefined) ??
            "*";
          const channelKey =
            entry.channelId ??
            (entry.channelName ? normalizeDiscordSlug(entry.channelName) : undefined);
          if (!channelKey && guildKey === "*") {
            continue;
          }
          allowlistEntries.push({ guildKey, ...(channelKey ? { channelKey } : {}) });
        }
        return setDiscordGuildChannelAllowlist(cfg, discordAccountId, allowlistEntries);
      },
    });

    return { cfg: next, accountId: discordAccountId };
  },
  dmPolicy,
  disable: (cfg) => setOnboardingChannelEnabled(cfg, channel, false),
};

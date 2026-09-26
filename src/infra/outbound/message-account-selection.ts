import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isChannelAccountExplicitlyDisabled } from "../../channels/account-config-enabled.js";
import {
  channelHasConfiguredState,
  resolveChannelAccount,
} from "../../channels/account-resolution.js";
import { resolveChannelAccountEnabled } from "../../channels/account-summary.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { assertSecretOwnerAvailable } from "../../secrets/runtime-degraded-state.js";
import { isAccountEnabled } from "../../shared/account-enabled.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import { isConfiguredChannel } from "./channel-selection.js";
import { MessageActionDeniedError } from "./message-action-denial.js";
import { listRuntimeVisibleChannelPlugins } from "./runtime-visible-channels.js";

export type MessageBroadcastAccountPlan = {
  accountId: string;
  candidateChannels: ChannelId[];
  secretChannels: ChannelId[];
};

function resolveListedAccountId(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): string | undefined {
  const listedAccountId = params.plugin.config
    .listAccountIds(params.cfg)
    .find((candidate) => normalizeOptionalAccountId(candidate) === params.accountId);
  if (listedAccountId) {
    return listedAccountId;
  }
  const defaultAccountId = resolveChannelDefaultAccountId({
    plugin: params.plugin,
    cfg: params.cfg,
  });
  return normalizeOptionalAccountId(defaultAccountId) === params.accountId
    ? defaultAccountId
    : undefined;
}

/**
 * Binds a caller-supplied message account to one listed channel account.
 * Host-derived defaults and binding accounts bypass this helper by design.
 */
export async function validateExplicitMessageAccountSelection(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: unknown;
  plugin?: ChannelPlugin;
  checkResolvedAccount?: boolean;
}): Promise<string | undefined> {
  const rawAccountId = normalizeOptionalString(params.accountId);
  if (!rawAccountId) {
    return undefined;
  }
  const accountId = normalizeOptionalAccountId(rawAccountId);
  if (!accountId) {
    throw new MessageActionDeniedError(
      `Invalid account ID "${rawAccountId}".`,
      "message_account_invalid",
      "message-account:valid",
    );
  }
  const channel = normalizeOptionalString(params.channel);
  if (!channel) {
    return accountId;
  }
  const plugin =
    params.plugin ??
    resolveOutboundChannelPlugin({
      channel,
      cfg: params.cfg,
    }) ??
    getChannelPlugin(channel);
  if (!plugin) {
    return accountId;
  }
  const listedAccountId = resolveListedAccountId({ plugin, cfg: params.cfg, accountId });
  if (!listedAccountId) {
    throw new MessageActionDeniedError(
      `Unknown account "${rawAccountId}" for channel ${channel}.`,
      "message_account_unknown",
      "message-account:known",
    );
  }
  if (
    isChannelAccountExplicitlyDisabled({
      cfg: params.cfg,
      channel: plugin.id,
      accountId: listedAccountId,
    })
  ) {
    throw new MessageActionDeniedError(
      `Account "${listedAccountId}" for channel ${channel} is disabled.`,
      "message_account_disabled",
      "message-account:enabled",
    );
  }
  if (params.checkResolvedAccount !== false) {
    assertSecretOwnerAvailable("account", `${plugin.id}:${accountId}`);
    const account = await resolveChannelAccount({ plugin, cfg: params.cfg, accountId });
    assertSecretOwnerAvailable("account", `${plugin.id}:${accountId}`);
    if (
      isChannelAccountExplicitlyDisabled({
        cfg: params.cfg,
        channel: plugin.id,
        accountId: listedAccountId,
      }) ||
      !resolveChannelAccountEnabled({ plugin, account, cfg: params.cfg })
    ) {
      throw new MessageActionDeniedError(
        `Account "${listedAccountId}" for channel ${channel} is disabled.`,
        "message_account_disabled",
        "message-account:enabled",
      );
    }
  }
  return accountId;
}

/** Checks configured and enabled state after channel availability is resolved. */
export async function isPotentialConfiguredMessageChannel(params: {
  cfg: OpenClawConfig;
  plugin: ChannelPlugin;
}): Promise<boolean> {
  const channelConfig = (params.cfg.channels as Record<string, unknown> | undefined)?.[
    params.plugin.id
  ];
  if (
    channelConfig &&
    typeof channelConfig === "object" &&
    !Array.isArray(channelConfig) &&
    (channelConfig as { enabled?: unknown }).enabled === false
  ) {
    return false;
  }
  if (isConfiguredChannel(params.cfg, params.plugin.id)) {
    return true;
  }
  try {
    return (
      (await channelHasConfiguredState({
        plugin: params.plugin,
        cfg: params.cfg,
        env: process.env,
      })) === true
    );
  } catch {
    return false;
  }
}

/**
 * Plans an unscoped broadcast before SecretRefs are resolved. Rejected routes
 * stay in candidateChannels for per-channel errors but cannot expose secrets.
 * Host-derived binding/default accounts do not use this explicit-account plan.
 */
export async function resolveMessageBroadcastAccountPlan(params: {
  cfg: OpenClawConfig;
  accountId: unknown;
}): Promise<MessageBroadcastAccountPlan | undefined> {
  const accountId = await validateExplicitMessageAccountSelection({
    cfg: params.cfg,
    accountId: params.accountId,
    checkResolvedAccount: false,
  });
  if (!accountId) {
    return undefined;
  }

  const candidatePlugins: ChannelPlugin[] = [];
  for (const plugin of listRuntimeVisibleChannelPlugins()) {
    if (
      resolveOutboundChannelPlugin({ channel: plugin.id, cfg: params.cfg }) &&
      (await isPotentialConfiguredMessageChannel({ cfg: params.cfg, plugin }))
    ) {
      candidatePlugins.push(plugin);
    }
  }
  const secretChannels: ChannelId[] = [];
  for (const plugin of candidatePlugins) {
    try {
      await validateExplicitMessageAccountSelection({
        cfg: params.cfg,
        channel: plugin.id,
        accountId,
        plugin,
        checkResolvedAccount: false,
      });
      // Prefer the SecretRef-safe metadata view. Legacy plugins without it keep
      // their existing resolver contract; a resolver that cannot read refs fails closed.
      const inspection = plugin.config.inspectAccount?.(params.cfg, accountId);
      const account =
        inspection ?? (await resolveChannelAccount({ plugin, cfg: params.cfg, accountId }));
      const enabled =
        account !== undefined &&
        (inspection != null
          ? isAccountEnabled(inspection)
          : resolveChannelAccountEnabled({ plugin, account, cfg: params.cfg }));
      if (enabled) {
        secretChannels.push(plugin.id);
      }
    } catch {
      // Accounts whose runtime state cannot be resolved are excluded from secret redemption.
    }
  }

  return {
    accountId,
    candidateChannels: candidatePlugins.map((plugin) => plugin.id),
    secretChannels,
  };
}

import { asNullableRecord as asObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { writeChannelSection } from "./config-helpers.js";
import { resolveChannelDmAllowFrom, resolveChannelDmPolicy } from "./dm-access.js";
import {
  addWildcardAllowFrom,
  patchChannelConfigForAccount,
  promptResolvedAllowFrom,
  resolveSetupAccountId,
  splitSetupEntries,
} from "./setup-wizard-helpers.js";
import type { ChannelSetupDmPolicy } from "./setup-wizard-types.js";

function resolveLegacyChannelConfig(cfg: OpenClawConfig, channel: string): Record<string, unknown> {
  return asObjectRecord(cfg.channels?.[channel]) ?? {};
}

function resolveLegacyChannelAccount(
  cfg: OpenClawConfig,
  channel: string,
  accountId: string,
): Record<string, unknown> | null {
  const channelConfig = resolveLegacyChannelConfig(cfg, channel);
  return asObjectRecord(asObjectRecord(channelConfig.accounts)?.[accountId]);
}

function patchLegacyChannelConfig(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  if (params.accountId !== undefined && params.accountId !== DEFAULT_ACCOUNT_ID) {
    return patchChannelConfigForAccount({ ...params, accountId: params.accountId });
  }
  const channelConfig = resolveLegacyChannelConfig(params.cfg, params.channel);
  const dmConfig = asObjectRecord(channelConfig.dm) ?? {};
  return writeChannelSection(params.cfg, params.channel, {
    ...channelConfig,
    ...params.patch,
    dm: {
      ...dmConfig,
      enabled: typeof dmConfig.enabled === "boolean" ? dmConfig.enabled : true,
    },
  });
}

/** @deprecated Compatibility for plugins published before setup policy became plugin-owned. */
export function createLegacyCompatChannelDmPolicy(params: {
  label: string;
  channel: string;
  promptAllowFrom?: ChannelSetupDmPolicy["promptAllowFrom"];
}): ChannelSetupDmPolicy {
  const configKeys = (accountId?: string) => {
    const accountPath =
      accountId && accountId !== DEFAULT_ACCOUNT_ID ? `.accounts.${accountId}` : "";
    return {
      policyKey: `channels.${params.channel}${accountPath}.dmPolicy`,
      allowFromKey: `channels.${params.channel}${accountPath}.allowFrom`,
    };
  };
  return {
    label: params.label,
    channel: params.channel,
    ...configKeys(),
    resolveConfigKeys: (_cfg, accountId) => configKeys(accountId),
    getCurrent: (cfg, accountId) => {
      const channelConfig = resolveLegacyChannelConfig(cfg, params.channel);
      const accountConfig =
        accountId && accountId !== DEFAULT_ACCOUNT_ID
          ? resolveLegacyChannelAccount(cfg, params.channel, accountId)
          : undefined;
      return (
        resolveChannelDmPolicy({
          account: accountConfig,
          parent: channelConfig,
          defaultPolicy: "pairing",
        }) ?? "pairing"
      );
    },
    setPolicy: (cfg, policy, accountId) => {
      const namedAccountId = accountId && accountId !== DEFAULT_ACCOUNT_ID ? accountId : undefined;
      const allowFrom =
        policy === "open"
          ? addWildcardAllowFrom(
              resolveChannelDmAllowFrom({
                account: namedAccountId
                  ? resolveLegacyChannelAccount(cfg, params.channel, namedAccountId)
                  : undefined,
                parent: resolveLegacyChannelConfig(cfg, params.channel),
              }),
            )
          : undefined;
      const patch = { dmPolicy: policy, ...(allowFrom ? { allowFrom } : {}) };
      return patchLegacyChannelConfig({
        cfg,
        channel: params.channel,
        accountId: namedAccountId,
        patch,
      });
    },
    ...(params.promptAllowFrom ? { promptAllowFrom: params.promptAllowFrom } : {}),
  };
}

/** @deprecated Compatibility for plugins published before setup allowlists became plugin-owned. */
export async function promptLegacyChannelAllowFromForAccount<TAccount>(params: {
  cfg: OpenClawConfig;
  channel: string;
  prompter: WizardPrompter;
  accountId?: string;
  defaultAccountId: string;
  resolveAccount: (cfg: OpenClawConfig, accountId: string) => TAccount;
  resolveExisting: (account: TAccount, cfg: OpenClawConfig) => Array<string | number>;
  resolveToken: (account: TAccount) => string | null | undefined;
  noteTitle: string;
  noteLines: string[];
  message: string;
  placeholder: string;
  parseId: (value: string) => string | null;
  invalidWithoutTokenNote: string;
  resolveEntries: Parameters<typeof promptResolvedAllowFrom>[0]["resolveEntries"];
}): Promise<OpenClawConfig> {
  const accountId = resolveSetupAccountId({
    accountId: params.accountId,
    defaultAccountId: params.defaultAccountId,
  });
  const account = params.resolveAccount(params.cfg, accountId);
  await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
  const allowFrom = await promptResolvedAllowFrom({
    prompter: params.prompter,
    existing: params.resolveExisting(account, params.cfg),
    token: params.resolveToken(account),
    message: params.message,
    placeholder: params.placeholder,
    label: params.noteTitle,
    parseInputs: splitSetupEntries,
    parseId: params.parseId,
    invalidWithoutTokenNote: params.invalidWithoutTokenNote,
    resolveEntries: params.resolveEntries,
  });
  return patchLegacyChannelConfig({
    cfg: params.cfg,
    channel: params.channel,
    accountId,
    patch: { allowFrom },
  });
}

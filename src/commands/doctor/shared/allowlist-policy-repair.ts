import {
  asNullableRecord,
  asOptionalObjectRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { normalizeChatChannelId } from "../../../channels/ids.js";
import {
  resolveChannelDmAccess,
  setCanonicalDmAllowFrom,
  type ChannelDmAllowFromMode,
} from "../../../channels/plugins/dm-access.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { readChannelAllowFromStore } from "../../../pairing/pairing-store.js";
import { normalizeAccountId } from "../../../routing/session-key.js";
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
import { hasAllowFromEntries } from "./allowlist.js";

export async function maybeRepairAllowlistPolicyAllowFrom(cfg: OpenClawConfig): Promise<{
  config: OpenClawConfig;
  changes: string[];
}> {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];

  const recoverAllowFromForAccount = async (params: {
    channelName: string;
    // Resolved once per channel by the caller: the lookup can materialize a bundled
    // channel plugin, so recomputing it per account turns repair into plugin loading.
    mode: ChannelDmAllowFromMode;
    account: Record<string, unknown>;
    parent?: Record<string, unknown>;
    accountId?: string;
    prefix: string;
  }) => {
    const { mode } = params;
    const { dmPolicy, allowFrom } = resolveChannelDmAccess({
      account: params.account,
      parent: params.parent,
      mode,
    });
    if (dmPolicy !== "allowlist" || hasAllowFromEntries(allowFrom)) {
      return;
    }

    const normalizedChannelId = normalizeOptionalLowercaseString(
      normalizeChatChannelId(params.channelName) ?? params.channelName,
    );
    if (!normalizedChannelId) {
      return;
    }
    const normalizedAccountId = normalizeAccountId(params.accountId);
    const fromStore = await readChannelAllowFromStore(
      normalizedChannelId,
      process.env,
      normalizedAccountId,
    ).catch(() => []);
    const recovered = normalizeUniqueStringEntries(fromStore);
    if (recovered.length === 0) {
      return;
    }

    const count = recovered.length;
    const noun = count === 1 ? "entry" : "entries";
    setCanonicalDmAllowFrom({
      entry: params.account,
      allowFrom: recovered,
      mode,
      pathPrefix: params.prefix,
      changes,
      reason: `restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`,
    });
  };

  for (const [channelName, value] of Object.entries(next.channels ?? {})) {
    const channelConfig = asOptionalObjectRecord(value);
    if (!channelConfig || channelConfig.enabled === false) {
      continue;
    }
    const mode = getDoctorChannelCapabilities(channelName).dmAllowFromMode;
    await recoverAllowFromForAccount({
      channelName,
      mode,
      account: channelConfig,
      prefix: `channels.${channelName}`,
    });

    const accounts = asNullableRecord(channelConfig.accounts);
    if (!accounts) {
      continue;
    }
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      const accountConfig = asOptionalObjectRecord(accountValue);
      if (!accountConfig || accountConfig.enabled === false) {
        continue;
      }
      await recoverAllowFromForAccount({
        channelName,
        mode,
        account: accountConfig,
        parent: channelConfig,
        accountId,
        prefix: `channels.${channelName}.accounts.${accountId}`,
      });
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}

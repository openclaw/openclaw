import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { normalizeChatChannelId } from "../../../channels/ids.js";
import {
  resolveChannelDmAccess,
  setCanonicalDmAllowFrom,
} from "../../../channels/plugins/dm-access.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { readChannelAllowFromStore } from "../../../pairing/pairing-store.js";
import { normalizeAccountId } from "../../../routing/session-key.js";
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
import { hasAllowFromEntries, iterateDoctorChannelAccounts } from "./allowlist.js";

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

  for (const [channelName, value] of Object.entries(next.channels ?? {})) {
    const channelConfig = asOptionalObjectRecord(value);
    if (!channelConfig || channelConfig.enabled === false) {
      continue;
    }
    const mode = getDoctorChannelCapabilities(channelName).dmAllowFromMode;
    const recoverAllowFromForAccount = async (params: {
      account: Record<string, unknown>;
      parent?: Record<string, unknown>;
      accountId?: string;
      prefix: string;
    }) => {
      const { dmPolicy, allowFrom } = resolveChannelDmAccess({
        account: params.account,
        parent: params.parent,
        mode,
      });
      if (dmPolicy !== "allowlist" || hasAllowFromEntries(allowFrom)) {
        return;
      }

      const normalizedChannelId = normalizeOptionalLowercaseString(
        normalizeChatChannelId(channelName) ?? channelName,
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
    for (const account of iterateDoctorChannelAccounts(
      channelConfig,
      `channels.${channelName}`,
      true,
    )) {
      await recoverAllowFromForAccount(account);
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}

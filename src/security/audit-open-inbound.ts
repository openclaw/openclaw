import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  resolveChannelDmPolicy,
  type ChannelDmAllowFromMode,
} from "../channels/plugins/dm-access.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { listPotentialAgentIdsForRoute } from "../routing/resolve-route.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

type OpenInboundPolicy = { path: string; channel: string; accountIds: string[] };

/** Resolve configured open scopes once, using the selected channel metadata's DM precedence. */
export function listConfiguredOpenInboundPolicies(
  cfg: OpenClawConfig,
  channels: readonly PluginPackageChannel[] = [],
): OpenInboundPolicy[] {
  const modes = new Map<string, ChannelDmAllowFromMode>();
  for (const channel of channels) {
    const mode = channel.doctorCapabilities?.dmAllowFromMode;
    if (mode && channel.id) {
      for (const id of [channel.id, ...(channel.aliases ?? [])]) {
        modes.set(id, mode);
      }
    }
  }
  const policies: OpenInboundPolicy[] = [];
  const visit = (
    value: unknown,
    scope: string,
    mode: ChannelDmAllowFromMode,
    channel: string,
    accountIds: string[],
  ) => {
    const record = asNullableRecord(value);
    if (!record) {
      return;
    }
    if (record.groupPolicy === "open") {
      policies.push({ path: `${scope}.groupPolicy`, channel, accountIds });
    }
    if (resolveChannelDmPolicy({ account: record, mode }) === "open") {
      const nestedWins =
        mode === "nestedOnly"
          ? asNullableRecord(record.dm)?.policy != null
          : record.dmPolicy == null;
      policies.push({
        path: `${scope}.${nestedWins ? "dm.policy" : "dmPolicy"}`,
        channel,
        accountIds,
      });
    }
    for (const [key, nested] of Object.entries(record)) {
      if (scope === `channels.${channel}` && key === "accounts") {
        for (const [accountId, account] of Object.entries(asNullableRecord(nested) ?? {})) {
          visit(account, `${scope}.accounts.${accountId}`, mode, channel, [accountId]);
        }
      } else {
        visit(nested, `${scope}.${key}`, mode, channel, accountIds);
      }
    }
  };
  for (const [id, channel] of Object.entries(cfg.channels ?? {})) {
    if (id !== "modelByChannel" && id !== "tools") {
      const section = asNullableRecord(channel);
      const accountIds = [
        DEFAULT_ACCOUNT_ID,
        ...Object.keys(asNullableRecord(section?.accounts) ?? {}),
        ...(typeof section?.defaultAccount === "string" ? [section.defaultAccount] : []),
      ];
      visit(channel, `channels.${id}`, modes.get(id) ?? "topOnly", id, accountIds);
    }
  }
  return policies;
}

export function listConfiguredOpenInboundPolicyPaths(
  cfg: OpenClawConfig,
  channels: readonly PluginPackageChannel[] = [],
): string[] {
  return listConfiguredOpenInboundPolicies(cfg, channels)
    .map(({ path }) => path)
    .toSorted();
}

/** Unresolved ownership keeps the audit's conservative all-agent analysis. */
export function resolveOpenInboundAgentIds(
  cfg: OpenClawConfig,
  policies: readonly OpenInboundPolicy[],
): Set<string> | undefined {
  const agentIds = new Set<string>();
  for (const policy of policies) {
    for (const accountId of policy.accountIds) {
      const owners = listPotentialAgentIdsForRoute({ cfg, channel: policy.channel, accountId });
      if (!owners) {
        return undefined;
      }
      for (const owner of owners) {
        agentIds.add(owner);
      }
    }
  }
  return agentIds;
}

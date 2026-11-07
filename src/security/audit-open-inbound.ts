import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds } from "../agents/agent-scope-config.js";
import {
  resolveChannelDmPolicy,
  type ChannelDmAllowFromMode,
} from "../channels/plugins/dm-access.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import type { AnyChannelPlugin } from "../channels/plugins/types.plugin.js";
import { listAcpBindings } from "../config/bindings.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { normalizeRouteBindingChannelId } from "../routing/binding-scope.js";
import { listPotentialAgentIdsForRoute } from "../routing/resolve-route.js";

type OpenInboundPolicy = {
  path: string;
  channel: string;
  accountIds?: string[];
  hasChannelAgentOverride?: boolean;
};

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
  const agentOverrideChannels = new Set<string>();
  const visit = (
    value: unknown,
    scope: string,
    mode: ChannelDmAllowFromMode,
    channel: string,
    accountIds?: string[],
  ) => {
    const record = asNullableRecord(value);
    if (!record) {
      return;
    }
    if (typeof record.agentId === "string" && record.agentId.trim()) {
      agentOverrideChannels.add(channel);
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
      visit(channel, `channels.${id}`, modes.get(id) ?? "topOnly", id);
    }
  }
  for (const policy of policies) {
    policy.hasChannelAgentOverride = agentOverrideChannels.has(policy.channel);
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
export async function resolveOpenInboundAgentIds(
  cfg: OpenClawConfig,
  policies: readonly OpenInboundPolicy[],
  context: { plugins: readonly AnyChannelPlugin[]; env: NodeJS.ProcessEnv; stateDir: string },
): Promise<Set<string> | undefined> {
  const agentIds = new Set<string>();
  const knownAgentIds = new Set(listAgentIds(cfg));
  const inspectedAccounts = new Set<string>();
  for (const policy of policies) {
    // Core bindings cannot exhaust channel-owned routes such as Telegram topic overrides.
    if (policy.hasChannelAgentOverride) {
      return undefined;
    }
    const plugin = context.plugins.find(
      (entry) => entry.id === policy.channel || entry.meta.aliases?.includes(policy.channel),
    );
    const resolveTargets = plugin?.security?.resolveAuditRouteTargets;
    if (!plugin || !resolveTargets) {
      return undefined;
    }
    // Configured ACP routes are applied after ordinary bindings even when the
    // channel disables live thread bindings. Their compiler owns conversation matching.
    if (
      listAcpBindings(cfg).some(
        (binding) => normalizeRouteBindingChannelId(binding.match.channel) === plugin.id,
      )
    ) {
      return undefined;
    }
    try {
      const accountIds = policy.accountIds ?? [
        resolveChannelDefaultAccountId({ plugin, cfg }),
        ...plugin.config.listAccountIds(cfg),
      ];
      for (const rawAccountId of accountIds) {
        const accountId = normalizeOptionalAccountId(rawAccountId);
        if (!accountId) {
          return undefined;
        }
        const key = `${plugin.id}:${accountId}`;
        if (inspectedAccounts.has(key)) {
          continue;
        }
        const owners = listPotentialAgentIdsForRoute({ cfg, channel: plugin.id, accountId });
        if (!owners) {
          return undefined;
        }
        const targets = await resolveTargets({
          cfg,
          accountId,
          env: context.env,
          stateDir: context.stateDir,
        });
        if (targets.kind !== "complete") {
          return undefined;
        }
        for (const agentId of [...owners, ...targets.additionalAgentIds]) {
          if (!knownAgentIds.has(agentId)) {
            return undefined;
          }
          agentIds.add(agentId);
        }
        inspectedAccounts.add(key);
      }
    } catch {
      // An unavailable owner must never turn a partial route inventory into reassurance.
      return undefined;
    }
  }
  return agentIds;
}

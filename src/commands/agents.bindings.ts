import { expectDefined } from "@openclaw/normalization-core";
// Pure helpers for parsing, adding, removing, and generating agent route bindings.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { getBundledChannelSetupPlugin } from "../channels/plugins/bundled.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { normalizeChannelId as normalizeBundledChannelId } from "../channels/registry.js";
import { formatUnknownChannelMessage } from "../cli/error-format.js";
import { isRouteBinding, listRouteBindings } from "../config/bindings.js";
import type { AgentRouteBinding } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listManifestChannelContributionIds } from "../plugins/manifest-contribution-ids.js";
import { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { ChannelChoice } from "./onboard-types.js";

export { describeBinding } from "./agents.binding-format.js";

function bindingMatchKey(match: AgentRouteBinding["match"]) {
  const accountId = normalizeOptionalString(match.accountId) || DEFAULT_ACCOUNT_ID;
  const identityKey = bindingMatchIdentityKey(match);
  return JSON.stringify([identityKey, accountId]);
}

function bindingMatchIdentityKey(match: AgentRouteBinding["match"]) {
  const roles = Array.isArray(match.roles) ? normalizeSortedUniqueStringEntries(match.roles) : [];
  return JSON.stringify([
    match.channel,
    match.peer?.kind ?? "",
    match.peer?.id ?? "",
    match.guildId ?? "",
    match.teamId ?? "",
    roles.join(","),
  ]);
}

function canUpgradeBindingAccountScope(params: {
  existing: AgentRouteBinding;
  incoming: AgentRouteBinding;
  normalizedIncomingAgentId: string;
}): boolean {
  if (!normalizeOptionalString(params.incoming.match.accountId)) {
    return false;
  }
  if (normalizeOptionalString(params.existing.match.accountId)) {
    return false;
  }
  if (normalizeAgentId(params.existing.agentId) !== params.normalizedIncomingAgentId) {
    return false;
  }
  return (
    bindingMatchIdentityKey(params.existing.match) ===
    bindingMatchIdentityKey(params.incoming.match)
  );
}

/** Merge new route bindings into config while reporting adds, upgrades, skips, and conflicts. */
export function applyAgentBindings(
  cfg: OpenClawConfig,
  bindings: AgentRouteBinding[],
): {
  config: OpenClawConfig;
  added: AgentRouteBinding[];
  updated: AgentRouteBinding[];
  skipped: AgentRouteBinding[];
  conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }>;
} {
  const existingRoutes = [...listRouteBindings(cfg)];
  const nonRouteBindings = (cfg.bindings ?? []).filter((binding) => !isRouteBinding(binding));
  const existingMatchMap = new Map<string, string>();
  for (const binding of existingRoutes) {
    const key = bindingMatchKey(binding.match);
    if (!existingMatchMap.has(key)) {
      existingMatchMap.set(key, normalizeAgentId(binding.agentId));
    }
  }

  const added: AgentRouteBinding[] = [];
  const updated: AgentRouteBinding[] = [];
  const skipped: AgentRouteBinding[] = [];
  const conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }> = [];

  for (const binding of bindings) {
    const agentId = normalizeAgentId(binding.agentId);
    const key = bindingMatchKey(binding.match);
    const existingAgentId = existingMatchMap.get(key);
    if (existingAgentId) {
      if (existingAgentId === agentId) {
        skipped.push(binding);
      } else {
        conflicts.push({ binding, existingAgentId });
      }
      continue;
    }

    const upgradeIndex = existingRoutes.findIndex((candidate) =>
      canUpgradeBindingAccountScope({
        existing: candidate,
        incoming: binding,
        normalizedIncomingAgentId: agentId,
      }),
    );
    if (upgradeIndex >= 0) {
      const current = existingRoutes[upgradeIndex];
      if (!current) {
        continue;
      }
      const previousKey = bindingMatchKey(current.match);
      const upgradedBinding: AgentRouteBinding = {
        ...current,
        agentId,
        match: {
          ...current.match,
          accountId: binding.match.accountId?.trim(),
        },
      };
      existingRoutes[upgradeIndex] = upgradedBinding;
      existingMatchMap.delete(previousKey);
      existingMatchMap.set(bindingMatchKey(upgradedBinding.match), agentId);
      updated.push(upgradedBinding);
      continue;
    }

    existingMatchMap.set(key, agentId);
    added.push({ ...binding, agentId });
  }

  if (added.length === 0 && updated.length === 0) {
    return { config: cfg, added, updated, skipped, conflicts };
  }

  return {
    config: {
      ...cfg,
      bindings: [...existingRoutes, ...added, ...nonRouteBindings],
    },
    added,
    updated,
    skipped,
    conflicts,
  };
}

/** Remove matching route bindings from config without disturbing non-route binding entries. */
export function removeAgentBindings(
  cfg: OpenClawConfig,
  bindings: AgentRouteBinding[],
): {
  config: OpenClawConfig;
  removed: AgentRouteBinding[];
  missing: AgentRouteBinding[];
  conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }>;
} {
  const existingRoutes = listRouteBindings(cfg);
  const nonRouteBindings = (cfg.bindings ?? []).filter((binding) => !isRouteBinding(binding));
  const removeIndexes = new Set<number>();
  const removed: AgentRouteBinding[] = [];
  const missing: AgentRouteBinding[] = [];
  const conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }> = [];

  for (const binding of bindings) {
    const desiredAgentId = normalizeAgentId(binding.agentId);
    const key = bindingMatchKey(binding.match);
    let matchedIndex = -1;
    let conflictingAgentId: string | null = null;
    for (let i = 0; i < existingRoutes.length; i += 1) {
      if (removeIndexes.has(i)) {
        continue;
      }
      const current = existingRoutes[i];
      if (!current || bindingMatchKey(current.match) !== key) {
        continue;
      }
      const currentAgentId = normalizeAgentId(current.agentId);
      if (currentAgentId === desiredAgentId) {
        matchedIndex = i;
        break;
      }
      conflictingAgentId = currentAgentId;
    }
    if (matchedIndex >= 0) {
      const matched = existingRoutes[matchedIndex];
      if (matched) {
        removeIndexes.add(matchedIndex);
        removed.push(matched);
      }
      continue;
    }
    if (conflictingAgentId) {
      conflicts.push({ binding, existingAgentId: conflictingAgentId });
      continue;
    }
    missing.push(binding);
  }

  if (removeIndexes.size === 0) {
    return { config: cfg, removed, missing, conflicts };
  }

  const nextRouteBindings = existingRoutes.filter((_, index) => !removeIndexes.has(index));
  const nextBindings = [...nextRouteBindings, ...nonRouteBindings];
  return {
    config: {
      ...cfg,
      bindings: nextBindings.length > 0 ? nextBindings : undefined,
    },
    removed,
    missing,
    conflicts,
  };
}

function resolveDefaultAccountId(cfg: OpenClawConfig, provider: ChannelId): string {
  const plugin = getBindingChannelPlugin(provider);
  if (!plugin) {
    return DEFAULT_ACCOUNT_ID;
  }
  return resolveChannelDefaultAccountId({ plugin, cfg });
}

function listManifestChannelIds(config: OpenClawConfig): Set<string> {
  return new Set(
    listManifestChannelContributionIds({
      includeDisabled: true,
      config,
      env: process.env,
    }),
  );
}

function normalizeBindingChannelId(
  raw: string | undefined,
  config: OpenClawConfig,
): ChannelId | null {
  const bundled = normalizeBundledChannelId(raw);
  if (bundled) {
    return bundled;
  }
  const normalized = normalizeOptionalString(raw)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  return listManifestChannelIds(config).has(normalized) ? normalized : null;
}

function getBindingChannelPlugin(channel: ChannelId) {
  return getLoadedChannelPlugin(channel) ?? getBundledChannelSetupPlugin(channel);
}

function resolveBindingAccountId(params: {
  channel: ChannelId;
  config: OpenClawConfig;
  agentId: string;
  explicitAccountId?: string;
}): string | undefined {
  const explicitAccountId = params.explicitAccountId?.trim();
  if (explicitAccountId) {
    return explicitAccountId;
  }

  const plugin = getBindingChannelPlugin(params.channel);
  const pluginAccountId = plugin?.setup?.resolveBindingAccountId?.({
    cfg: params.config,
    agentId: params.agentId,
  });
  if (pluginAccountId?.trim()) {
    return pluginAccountId.trim();
  }

  if (plugin && plugin.config.listAccountIds(params.config).length > 1) {
    return "*";
  }

  if (plugin?.meta.forceAccountBinding) {
    return resolveDefaultAccountId(params.config, params.channel);
  }

  return undefined;
}

export function buildChannelBindings(params: {
  agentId: string;
  selection: ChannelChoice[];
  config: OpenClawConfig;
  accountIds?: Partial<Record<ChannelChoice, string>>;
}): AgentRouteBinding[] {
  const bindings: AgentRouteBinding[] = [];
  const agentId = normalizeAgentId(params.agentId);
  for (const channel of params.selection) {
    const match: AgentRouteBinding["match"] = { channel };
    const explicitAccountId = params.accountIds?.[channel];

    // For feishu channel, treat explicit account IDs as peer IDs (group chats)
    // unless they are prefixed with "account:"
    if (channel === "feishu" && explicitAccountId) {
      if (explicitAccountId.startsWith("account:")) {
        // Explicit accountId syntax: feishu:account:xxx
        const accountId = explicitAccountId.slice("account:".length);
        if (accountId.trim()) {
          match.accountId = accountId.trim();
        }
      } else {
        // Default: treat as peer ID for group chats
        match.peer = { kind: "group" as const, id: explicitAccountId };
      }
    } else {
      // For other channels, use the existing logic
      const accountId = resolveBindingAccountId({
        channel,
        config: params.config,
        agentId,
        explicitAccountId,
      });
      if (accountId) {
        match.accountId = accountId;
      }
    }
    bindings.push({ type: "route", agentId, match });
  }
  return bindings;
}

export function parseBindingSpecs(params: {
  agentId: string;
  specs?: string[];
  config: OpenClawConfig;
}): { bindings: AgentRouteBinding[]; errors: string[] } {
  const bindings: AgentRouteBinding[] = [];
  const errors: string[] = [];
  const specs = params.specs ?? [];
  const agentId = normalizeAgentId(params.agentId);
  for (const raw of specs) {
    const trimmed = raw?.trim();
    if (!trimmed) {
      continue;
    }
    // Bind specs support two formats:
    // - <channel>:<peerId> for peer-based routing (e.g., feishu:oc_test for group chats)
    // - <channel>:account:<accountId> for explicit accountId routing (e.g., feishu:account:work)
    // Extra colon segments beyond these patterns are rejected.
    const parts = trimmed.split(":");
    const channelRaw = parts[0];
    const accountOrPeerRaw = parts[1];
    const accountPrefixRaw = parts[2];
    const extraSegments = parts.slice(3);

    if (extraSegments.length > 0) {
      errors.push(
        `Invalid binding "${trimmed}". Too many colon-separated segments. Use <channel>:<id> or <channel>:account:<id>.`,
      );
      continue;
    }

    const channel = normalizeBindingChannelId(channelRaw, params.config);
    if (!channel) {
      errors.push(
        formatUnknownChannelMessage({
          channel: expectDefined(channelRaw, "agents.bindings channel raw"),
        }),
      );
      continue;
    }

    const match: AgentRouteBinding["match"] = { channel };

    if (accountOrPeerRaw !== undefined) {
      // Check for explicit accountId syntax: <channel>:account:<id>
      if (accountOrPeerRaw.toLowerCase() === "account" && accountPrefixRaw !== undefined) {
        const accountId = accountPrefixRaw.trim();
        if (!accountId) {
          errors.push(
            `Invalid binding "${trimmed}". Account id is empty. Use <channel>:account:<id>.`,
          );
          continue;
        }
        match.accountId = accountId;
      } else if (accountOrPeerRaw.trim()) {
        // For feishu channel, treat as peer ID (group chat) by default
        if (channel === "feishu") {
          match.peer = { kind: "group" as const, id: accountOrPeerRaw.trim() };
        } else {
          // For other channels, use the existing accountId logic
          const accountId = resolveBindingAccountId({
            channel,
            config: params.config,
            agentId,
            explicitAccountId: accountOrPeerRaw.trim(),
          });
          if (accountId) {
            match.accountId = accountId;
          }
        }
      }
    }

    bindings.push({ type: "route", agentId, match });
  }
  return { bindings, errors };
}

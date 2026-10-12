import type { ConversationListResult } from "../../packages/gateway-protocol/src/schema/agent.js";
import { resolveChannelAccount } from "../channels/account-resolution.js";
import type { ChannelDirectoryEntry } from "../channels/plugins/types.core.js";
import {
  buildConversationIdentity,
  type ConversationIdentity,
} from "../config/sessions/conversation-identity.js";
import {
  listConversations,
  registerConversationAddresses,
  prepareConversationRegistryScope,
  type ConversationRecord,
} from "../config/sessions/conversation-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveOutboundChannelPlugin } from "../infra/outbound/channel-resolution.js";
import { resolveOutboundSessionRoute } from "../infra/outbound/outbound-session.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime } from "../runtime.js";
import {
  resolveConversationRouteEligibilitiesForAgent,
  prepareConversationRouteEligibilitiesForAgent,
} from "./conversation-route-ownership.js";

const log = createSubsystemLogger("gateway/conversations");

/** Lists persisted and channel-directory addresses from the Gateway's live plugin runtime. */
export async function runGatewayConversationList(
  params: {
    config: OpenClawConfig;
    readCurrentConfig?: () => OpenClawConfig;
    agentId: string;
    channel?: string;
    query?: string;
    limit: number;
  },
  deps = {
    listConversations,
    registerConversationAddresses,
    resolveOutboundChannelPlugin,
    resolveOutboundSessionRoute,
  },
): Promise<ConversationListResult> {
  const scope = await prepareConversationRegistryScope(params);
  const query = params.query?.trim() || undefined;
  let discoveryChannel: string | undefined;
  let registeredConversations: ConversationRecord[] | undefined;
  const discoveredConversationRefs = new Set<string>();
  if (params.channel) {
    const plugin = deps.resolveOutboundChannelPlugin({
      channel: params.channel,
      cfg: params.config,
    });
    discoveryChannel = plugin?.directory ? plugin.id : params.channel.trim().toLowerCase();
    if (plugin?.directory) {
      const identities = new Map<string, ConversationIdentity>();
      for (const accountId of new Set(
        plugin.config.listAccountIds(params.config).filter(Boolean),
      )) {
        const account = await resolveChannelAccount({ plugin, cfg: params.config, accountId });
        if (plugin.config.isEnabled?.(account, params.config) === false) {
          continue;
        }
        if (
          plugin.config.isConfigured &&
          !(await plugin.config.isConfigured(account, params.config))
        ) {
          continue;
        }
        const input = {
          cfg: params.config,
          accountId,
          ...(query ? { query } : {}),
          limit: params.limit,
          runtime: defaultRuntime,
        };
        const directory = plugin.directory;
        const listPeersLive = directory?.listPeersLive;
        const listGroupsLive = directory?.listGroupsLive;
        const listLiveDirectoryEntries = async (
          kind: "peers" | "groups",
          run: () => Promise<ChannelDirectoryEntry[]>,
        ): Promise<ChannelDirectoryEntry[]> => {
          try {
            return await run();
          } catch (error) {
            log.warn("live directory discovery failed; using configured entries", {
              channel: plugin.id,
              accountId,
              kind,
              error: formatErrorMessage(error),
            });
            return [];
          }
        };
        const [configuredPeers, livePeers, configuredGroups, liveGroups] = await Promise.all([
          directory?.listPeers?.(input) ?? [],
          listPeersLive ? listLiveDirectoryEntries("peers", () => listPeersLive(input)) : [],
          directory?.listGroups?.(input) ?? [],
          listGroupsLive ? listLiveDirectoryEntries("groups", () => listGroupsLive(input)) : [],
        ]);
        const entries = new Map<string, ChannelDirectoryEntry>();
        for (const entry of [
          ...configuredPeers,
          ...livePeers,
          ...configuredGroups,
          ...liveGroups,
        ]) {
          // Live results replace config-only metadata without dropping configured addresses when a
          // transport's live adapter is search-only and returns nothing for an unfiltered listing.
          entries.set(`${entry.kind}\u0000${entry.id.trim()}`, entry);
        }
        for (const entry of entries.values()) {
          const target = entry.id.trim();
          if (!target) {
            continue;
          }
          const display = entry.name?.trim() || entry.handle?.trim() || undefined;
          const route = await deps.resolveOutboundSessionRoute({
            cfg: params.config,
            channel: plugin.id,
            plugin,
            agentId: params.agentId,
            accountId,
            target,
            resolvedTarget: {
              to: target,
              kind: entry.kind,
              ...(display ? { display } : {}),
              source: "directory",
              resolutionSource: "directory",
            },
          });
          if (!route) {
            continue;
          }
          const identity = buildConversationIdentity({
            channel: plugin.id,
            accountId,
            kind: route.chatType,
            // Match inbound MsgContext.From; the identity builder removes transport prefixes.
            peerId: route.from,
            deliveryTarget: route.to,
            ...(route.threadId !== undefined ? { threadId: route.threadId } : {}),
            ...(route.peer.kind === "direct"
              ? { nativeDirectUserId: route.peer.id }
              : { nativeChannelId: route.peer.id }),
            ...(display ? { label: display } : {}),
          });
          if (identity) {
            identities.set(identity.conversationRef, identity);
          }
        }
      }
      const discoveredIdentities = [...identities.values()];
      const routeConfig = params.readCurrentConfig?.() ?? params.config;
      const prepared = await prepareConversationRouteEligibilitiesForAgent({
        config: routeConfig,
        agentId: params.agentId,
        conversations: discoveredIdentities.map((identity) => ({
          ...identity,
          target: identity.deliveryTarget,
        })),
      });
      const indexes = new Map(
        discoveredIdentities.map((identity, index) => [identity.conversationRef, index]),
      );
      try {
        registeredConversations = await deps.registerConversationAddresses(
          scope,
          discoveredIdentities,
          Date.now(),
          (candidates) => {
            if ((params.readCurrentConfig?.() ?? params.config) !== routeConfig)
              return candidates.map(() => false);
            const all = prepared.read();
            const eligibility = candidates.map(
              (identity) => all[indexes.get(identity.conversationRef) ?? -1] ?? "denied",
            );
            if (eligibility.includes("unavailable")) {
              throw new Error("Conversation route ownership is temporarily unavailable");
            }
            return eligibility.map((value) => value === "eligible");
          },
          { channel: discoveryChannel },
        );
      } finally {
        prepared.dispose();
      }
      for (const identity of discoveredIdentities) {
        discoveredConversationRefs.add(identity.conversationRef);
      }
    }
  }
  const conversations =
    registeredConversations ??
    (await deps.listConversations(
      scope,
      discoveryChannel !== undefined ? { channel: discoveryChannel } : {},
    ));
  const currentConfig = params.readCurrentConfig?.() ?? params.config;
  const normalizedQuery = query?.toLowerCase() ?? "";
  const searchQuery =
    normalizedQuery.startsWith("@") && normalizedQuery.length > 1
      ? normalizedQuery.slice(1)
      : normalizedQuery;
  const candidates = conversations.filter(
    (entry) =>
      !query ||
      discoveredConversationRefs.has(entry.conversationRef) ||
      [entry.conversationRef, entry.target, entry.label].some((value) =>
        value?.toLowerCase().includes(searchQuery),
      ),
  );
  const eligibility = await resolveConversationRouteEligibilitiesForAgent({
    config: currentConfig,
    agentId: params.agentId,
    conversations: candidates,
  });
  if (eligibility.includes("unavailable")) {
    throw new Error("Conversation route ownership is temporarily unavailable");
  }
  const selected = candidates
    .filter((_, index) => eligibility[index] === "eligible")
    .slice(0, params.limit);
  return {
    conversations: selected.map((conversation) => {
      const row: Omit<
        ConversationListResult["conversations"][number],
        "firstSeenAt" | "lastSeenAt"
      > = {
        conversationRef: conversation.conversationRef,
        channel: conversation.channel,
        accountId: conversation.accountId,
        kind: conversation.kind,
        target: conversation.target,
      };
      if (conversation.threadId) {
        row.threadId = conversation.threadId;
      }
      if (conversation.label) {
        row.label = conversation.label;
      }
      return Object.assign(row, {
        firstSeenAt: conversation.firstSeenAt,
        lastSeenAt: conversation.lastSeenAt,
      });
    }),
  };
}

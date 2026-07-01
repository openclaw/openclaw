// Control UI Chat page owns slash command metadata loading.
import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  getRemoteCommandEntries,
  replaceSlashCommands,
  type SlashCommandDef,
} from "../../lib/chat/commands.ts";

let refreshSeq = 0;
const REMOTE_SLASH_COMMAND_CACHE_TTL_MS = 60_000;

type RemoteSlashCommandCacheEntry = {
  commands?: SlashCommandDef[];
  expiresAt: number;
  inFlight?: Promise<SlashCommandDef[]>;
};

let remoteSlashCommandCache = new WeakMap<
  GatewayBrowserClient,
  Map<string, RemoteSlashCommandCacheEntry>
>();

function remoteSlashCommandCacheKey(agentId: string | undefined): string {
  return agentId ?? "";
}

function getRemoteSlashCommandCache(
  client: GatewayBrowserClient,
): Map<string, RemoteSlashCommandCacheEntry> {
  let cache = remoteSlashCommandCache.get(client);
  if (!cache) {
    cache = new Map();
    remoteSlashCommandCache.set(client, cache);
  }
  return cache;
}

function storeRemoteSlashCommands(
  client: GatewayBrowserClient,
  agentId: string | undefined,
  commands: SlashCommandDef[],
) {
  getRemoteSlashCommandCache(client).set(remoteSlashCommandCacheKey(agentId), {
    commands,
    expiresAt: Date.now() + REMOTE_SLASH_COMMAND_CACHE_TTL_MS,
  });
}

async function requestRemoteSlashCommands(
  client: GatewayBrowserClient,
  agentId: string | undefined,
  fallback: SlashCommandDef[] | undefined,
): Promise<SlashCommandDef[]> {
  try {
    const result = await client.request<CommandsListResult>("commands.list", {
      ...(agentId ? { agentId } : {}),
      includeArgs: true,
      scope: "text",
    });
    if (!Array.isArray(result?.commands)) {
      return buildFallbackSlashCommands();
    }
    const commands = buildSlashCommandsFromEntries(getRemoteCommandEntries(result));
    storeRemoteSlashCommands(client, agentId, commands);
    return commands;
  } catch {
    return fallback ?? buildFallbackSlashCommands();
  }
}

function loadRemoteSlashCommands(
  client: GatewayBrowserClient,
  agentId: string | undefined,
): Promise<SlashCommandDef[]> {
  const cache = getRemoteSlashCommandCache(client);
  const key = remoteSlashCommandCacheKey(agentId);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached?.commands && cached.expiresAt > now) {
    return Promise.resolve(cached.commands);
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }
  const inFlight = requestRemoteSlashCommands(client, agentId, cached?.commands).finally(() => {
    const latest = cache.get(key);
    if (latest?.inFlight === inFlight) {
      delete latest.inFlight;
    }
  });
  cache.set(key, {
    ...(cached?.commands ? { commands: cached.commands } : {}),
    expiresAt: cached?.expiresAt ?? 0,
    inFlight,
  });
  return inFlight;
}

export function applyRemoteSlashCommandsResult(params: {
  client: GatewayBrowserClient | null;
  agentId?: string | null;
  result: CommandsListResult | null | undefined;
}): boolean {
  if (!Array.isArray(params.result?.commands)) {
    return false;
  }
  const agentId = params.agentId?.trim();
  const commands = buildSlashCommandsFromEntries(getRemoteCommandEntries(params.result));
  if (params.client) {
    storeRemoteSlashCommands(params.client, agentId, commands);
  }
  refreshSeq += 1;
  replaceSlashCommands(commands);
  return true;
}

export async function refreshSlashCommands(params: {
  client: GatewayBrowserClient | null;
  agentId?: string | null;
}): Promise<void> {
  const seq = ++refreshSeq;
  const agentId = params.agentId?.trim();
  if (!params.client) {
    if (seq !== refreshSeq) {
      return;
    }
    replaceSlashCommands(buildFallbackSlashCommands());
    return;
  }
  const commands = await loadRemoteSlashCommands(params.client, agentId);
  if (seq !== refreshSeq) {
    return;
  }
  replaceSlashCommands(commands);
}

export function resetChatSlashCommandMetadataForTest(): void {
  refreshSeq = 0;
  remoteSlashCommandCache = new WeakMap();
  replaceSlashCommands(buildFallbackSlashCommands());
}

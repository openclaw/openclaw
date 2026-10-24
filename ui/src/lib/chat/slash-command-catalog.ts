import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { peekChatMetadata } from "./chat-metadata-store.ts";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  replaceSlashCommands,
  type SlashCommandDef,
} from "./commands.ts";

let refreshSeq = 0;
const REMOTE_SLASH_COMMAND_CACHE_TTL_MS = 60_000;

type RemoteSlashCommandCacheEntry = {
  commands?: SlashCommandDef[];
  expiresAt: number;
  inFlight?: Promise<SlashCommandDef[]>;
};

const remoteSlashCommandCache = new WeakMap<
  GatewayBrowserClient,
  Map<string, RemoteSlashCommandCacheEntry>
>();

function remoteSlashCommandCacheKey(agentId: string | undefined, sessionKey?: string): string {
  return JSON.stringify([agentId ?? null, sessionKey ?? null]);
}

async function requestRemoteSlashCommands(
  client: GatewayBrowserClient,
  agentId: string | undefined,
  sessionKey?: string,
): Promise<SlashCommandDef[] | undefined> {
  try {
    const result = await client.request<CommandsListResult>("commands.list", {
      ...(agentId ? { agentId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      includeArgs: true,
      scope: "text",
    });
    return buildSlashCommandsFromEntries(result.commands);
  } catch {
    return undefined;
  }
}

function loadRemoteSlashCommands(
  client: GatewayBrowserClient,
  agentId: string | undefined,
  sessionKey?: string,
): Promise<SlashCommandDef[]> {
  const metadata = peekChatMetadata(client, { agentId, sessionKey });
  // Store-held metadata carries app-level invalidation on config changes and logical reconnects,
  // so no TTL applies here. The cache below owns only commands.list-derived entries.
  if (metadata) {
    return Promise.resolve(buildSlashCommandsFromEntries(metadata.commands));
  }
  let cache = remoteSlashCommandCache.get(client);
  if (!cache) {
    cache = new Map();
    remoteSlashCommandCache.set(client, cache);
  }
  const key = remoteSlashCommandCacheKey(agentId, sessionKey);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached?.commands && cached.expiresAt > now) {
    return Promise.resolve(cached.commands);
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }
  const entry: RemoteSlashCommandCacheEntry = {
    commands: cached?.commands,
    expiresAt: cached?.expiresAt ?? 0,
  };
  const inFlight = requestRemoteSlashCommands(client, agentId, sessionKey)
    .then((commands) => {
      if (commands) {
        entry.commands = commands;
        entry.expiresAt = Date.now() + REMOTE_SLASH_COMMAND_CACHE_TTL_MS;
      }
      return commands ?? cached?.commands ?? buildFallbackSlashCommands();
    })
    .finally(() => {
      delete entry.inFlight;
    });
  entry.inFlight = inFlight;
  cache.set(key, entry);
  return inFlight;
}

export function invalidateSessionSlashCommands(
  client: GatewayBrowserClient,
  scope: { agentId: string; sessionKey: string },
): void {
  refreshSeq += 1;
  remoteSlashCommandCache
    .get(client)
    ?.delete(remoteSlashCommandCacheKey(scope.agentId, scope.sessionKey));
}

export function applyRemoteSlashCommandsResult(
  result: CommandsListResult | null | undefined,
): boolean {
  if (!result) {
    return false;
  }
  const commands = buildSlashCommandsFromEntries(result.commands);
  refreshSeq += 1;
  replaceSlashCommands(commands);
  return true;
}

export async function refreshSlashCommands(params: {
  client: GatewayBrowserClient | null;
  agentId?: string | null;
  sessionKey?: string;
  shouldApply?: () => boolean;
}): Promise<void> {
  const seq = ++refreshSeq;
  const agentId = params.agentId?.trim();
  const commands = params.client
    ? await loadRemoteSlashCommands(params.client, agentId, params.sessionKey)
    : undefined;
  if (seq !== refreshSeq || params.shouldApply?.() === false) {
    return;
  }
  replaceSlashCommands(commands ?? buildFallbackSlashCommands());
}

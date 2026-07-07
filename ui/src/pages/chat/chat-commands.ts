// Control UI Chat page owns slash command metadata loading.
import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  getRemoteCommandEntries,
  replaceSlashCommands,
  type SlashCommandDef,
} from "../../lib/chat/commands.ts";
import { scopedAgentIdForSession, type SessionCapability } from "../../lib/sessions/index.ts";
import { executeSlashCommand } from "./chat-command-executor.ts";
import { clearChatHistory } from "./chat-history.ts";
import { enqueuePendingRunMessage } from "./chat-queue.ts";
import { handleAbortChat } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

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

export type ChatCommandResetOptions = {
  previousDraft?: string;
  restoreDraft?: boolean;
};

type ChatCommandSendOptions = ChatCommandResetOptions & {
  sendResetMessage: (message: string, opts: ChatCommandResetOptions) => Promise<void>;
};

export type ChatCommandHost = Parameters<typeof handleAbortChat>[0] &
  Parameters<typeof clearChatHistory>[0] & {
    sessions: SessionCapability;
    chatQueue: ChatQueueItem[];
    chatModelCatalog: ModelCatalogEntry[];
    sessionsResult?: SessionsListResult | null;
    createChatSession?: () => Promise<void>;
    exportCurrentChat?: () => Promise<void> | void;
    refreshCurrentSessionTools?: () => Promise<void>;
    refreshCurrentChat?: () => Promise<void>;
  };

function setChatCommandError(
  host: { lastError?: string | null; chatError?: string | null },
  error: string | null,
) {
  host.lastError = error;
  host.chatError = error;
}

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

export function shouldQueueLocalSlashCommand(name: string): boolean {
  return !["stop", "export-session", "steer", "redirect", "new"].includes(name);
}

export async function dispatchChatSlashCommand(
  host: ChatCommandHost,
  name: string,
  args: string,
  opts: ChatCommandSendOptions,
) {
  switch (name) {
    case "stop":
      await handleAbortChat(host);
      return;
    case "new":
      if (!host.createChatSession) {
        setChatCommandError(host, "New Chat is unavailable.");
        return;
      }
      await host.createChatSession();
      return;
    case "reset":
      await opts.sendResetMessage(args ? `/reset ${args}` : "/reset", opts);
      return;
    case "clear":
      await clearChatHistory(host);
      return;
    case "export-session":
      await host.exportCurrentChat?.();
      return;
  }

  if (!host.client || !host.connected) {
    setChatCommandError(host, "Gateway not connected");
    injectCommandResult(
      host,
      `Cannot run \`/${name}\`: Control UI is not connected to the Gateway.`,
    );
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
    return;
  }

  const targetSessionKey = host.sessionKey;
  let result: Awaited<ReturnType<typeof executeSlashCommand>>;
  try {
    result = await executeSlashCommand(host.client, targetSessionKey, name, args, {
      sessions: host.sessions,
      chatModelCatalog: host.chatModelCatalog,
      sessionsResult: host.sessionsResult,
      agentId: scopedAgentIdForSession(host, targetSessionKey),
    });
  } catch (err) {
    setChatCommandError(host, String(err));
    injectCommandResult(host, `Command \`/${name}\` failed unexpectedly.`);
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
    return;
  }

  if (result.content) {
    injectCommandResult(host, result.content);
  }

  if (result.trackRunId) {
    host.chatRunId = result.trackRunId;
    host.chatStream = "";
    host.chatSending = false;
  }

  if (result.pendingCurrentRun && host.chatRunId) {
    enqueuePendingRunMessage(host, `/${name} ${args}`.trim(), host.chatRunId);
  }

  if (result.sessionPatch && "modelOverride" in result.sessionPatch) {
    host.sessions.setModelOverride(
      targetSessionKey,
      result.sessionPatch.modelOverride?.value ?? null,
    );
    await host.refreshCurrentSessionTools?.();
  }

  if (result.action === "refresh") {
    await host.refreshCurrentChat?.();
  }

  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}

function injectCommandResult(host: ChatCommandHost, content: string) {
  host.chatMessages = [
    ...host.chatMessages,
    {
      role: "system",
      content,
      timestamp: Date.now(),
    },
  ];
}

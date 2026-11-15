import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { fetchAssistantIdentity } from "../../app/assistant-identity.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasSameOriginGatewayTransport } from "../../dev-gateway.ts";
import {
  normalizeAssistantIdentity,
  type AssistantIdentity,
} from "../../lib/assistant-identity.ts";
import { isRenderableControlUiAvatarUrl } from "../../lib/avatar.ts";
import { readMessageSenderSession, resolveMessageRole } from "../../lib/chat/message-normalizer.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../../lib/identity-avatar-loader.ts";
import {
  DEFAULT_AGENT_ID,
  isUiGlobalSessionKey,
  parseAgentSessionKey,
  readSessionDefaults,
  resolveUiSelectedGlobalAgentId,
} from "../../lib/sessions/session-key.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";

export { ChatAvatar, ForwardedAvatar } from "./chat-avatar-view.tsx";

type ChatAvatarHost = {
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; agents?: AgentsListResult["agents"] } | null;
  chatAvatarReason?: string | null;
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  chatAvatarUrl: string | null;
  senderAgentAvatars?: ReadonlyMap<string, string | null>;
  client?: GatewayBrowserClient | null;
  connected: boolean;
  connectionEpoch?: number;
  hello: GatewayHelloOk | null;
  sessionKey: string;
  cacheChatAvatarSource?: (agentId: string, source: string | null) => void;
};

const chatAvatarRequestVersions = new WeakMap<object, number>();
const chatAvatarDisplayedAgents = new WeakMap<object, string>();
const senderAvatarRequests = new WeakMap<object, object>();
const senderAvatarInputs = new WeakMap<object, unknown[]>();

const CHAT_AVATAR_CACHE_LIMIT = 24;
const currentAvatarReference = Symbol("current-chat-avatar");
const chatAvatarReferences = new WeakMap<
  object,
  Map<string | typeof currentAvatarReference, () => void>
>();

export function resolveAgentIdForSession(
  host: Pick<ChatAvatarHost, "sessionKey" | "assistantAgentId" | "agentsList" | "hello">,
): string {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  if (isUiGlobalSessionKey(host.sessionKey)) {
    return resolveUiSelectedGlobalAgentId(host) || DEFAULT_AGENT_ID;
  }
  return readSessionDefaults(host)?.defaultAgentId?.trim() || DEFAULT_AGENT_ID;
}

export function cachedChatAssistantIdentity(
  state: Pick<ChatAvatarHost, "sessionKey" | "assistantAgentId" | "agentsList" | "hello">,
  context?: Pick<ApplicationContext, "agentIdentity" | "config" | "gateway">,
): AssistantIdentity {
  const agentId = resolveAgentIdForSession(state);
  const bootstrap = context?.config.current.assistantIdentity;
  if (
    context &&
    bootstrap?.agentId === agentId &&
    hasSameOriginGatewayTransport(context.gateway.connection.gatewayUrl)
  ) {
    return bootstrap;
  }
  const cached = context?.agentIdentity.get(agentId);
  if (cached) {
    return normalizeAssistantIdentity({ ...cached, avatar: cached.avatar || cached.emoji });
  }
  return { name: bootstrap && !bootstrap.agentId ? bootstrap.name : "", avatar: null };
}

function beginChatAvatarRequest(host: ChatAvatarHost): number {
  const nextVersion = (chatAvatarRequestVersions.get(host) ?? 0) + 1;
  chatAvatarRequestVersions.set(host, nextVersion);
  return nextVersion;
}

function clearChatAvatarState(host: ChatAvatarHost) {
  const references = chatAvatarReferences.get(host);
  references?.get(currentAvatarReference)?.();
  references?.delete(currentAvatarReference);
  host.chatAvatarUrl = null;
  host.chatAvatarStatus = null;
  host.chatAvatarReason = null;
}

function rememberChatAvatarReference(
  host: ChatAvatarHost,
  key: string | typeof currentAvatarReference,
  release: () => void,
) {
  let references = chatAvatarReferences.get(host);
  if (!references) {
    references = new Map();
    chatAvatarReferences.set(host, references);
  }
  references.get(key)?.();
  references.set(key, release);
}

export function invalidateChatAvatarCache(host: ChatAvatarHost): void {
  beginChatAvatarRequest(host);
  for (const release of chatAvatarReferences.get(host)?.values() ?? []) {
    release();
  }
  chatAvatarReferences.delete(host);
  chatAvatarDisplayedAgents.delete(host);
  senderAvatarRequests.delete(host);
  senderAvatarInputs.delete(host);
  host.senderAgentAvatars = undefined;
  clearChatAvatarState(host);
}

async function loadChatAvatarSnapshot(host: ChatAvatarHost, agentId: string) {
  const client = host.client;
  const connectionIsCurrent = captureChatConnectionOwner(host);
  const sessionAgentId = resolveAgentIdForSession(host);
  if (!client || !host.connected) {
    return null;
  }
  let release: () => void = () => undefined;
  try {
    const identity = await fetchAssistantIdentity(client, agentId);
    if (!identity || !connectionIsCurrent() || resolveAgentIdForSession(host) !== sessionAgentId) {
      return null;
    }
    const avatar = identity.avatar?.trim() ?? "";
    const managed = avatar.startsWith("/");
    const hasImage = managed || isRenderableControlUiAvatarUrl(avatar);
    const imageUrl = managed ? resolveAvatarImageUrl(avatar) : hasImage ? avatar : null;
    release = retainAvatarImageUrl(imageUrl);
    const url = await imageUrl;
    // A failed replacement keeps the displayed image; empty/text identities clear it.
    if (hasImage && url === null) {
      release();
      return null;
    }
    return {
      release,
      source: hasImage ? avatar : null,
      status: identity.avatarStatus ?? null,
      reason: identity.avatarReason ?? null,
      url,
    };
  } catch {
    release();
    return null;
  }
}

export async function refreshSenderAgentAvatars(
  host: (ChatAvatarHost & { chatMessages: unknown[] }) | undefined,
): Promise<void> {
  if (!host) {
    return;
  }
  const inputs = [
    host.chatMessages,
    host.agentsList,
    host.sessionKey,
    host.assistantAgentId,
    host.connected,
    host.client,
    host.connectionEpoch,
  ];
  const previous = senderAvatarInputs.get(host);
  if (previous && inputs.every((input, index) => input === previous[index])) {
    return;
  }
  senderAvatarInputs.set(host, inputs);
  // A unique token keeps a batch retired by invalidation from becoming current again.
  const request = {};
  senderAvatarRequests.set(host, request);
  const sessionKey = host.sessionKey;
  const agentId = resolveAgentIdForSession(host);
  const connectionIsCurrent = captureChatConnectionOwner(host);
  const agents = host.agentsList?.agents;
  const remainingIds = new Set(agents?.map((agent) => agent.id));
  // Consume each sender once, reserving one cache slot for the current agent.
  const ids: string[] = [];
  if (host.connected) {
    for (const message of host.chatMessages) {
      if (resolveMessageRole(message) !== "assistant") {
        continue;
      }
      const id = readMessageSenderSession(asOptionalRecord(message)?.senderSession)?.agentId;
      if (id && id !== agentId && remainingIds.delete(id)) {
        ids.push(id);
        if (ids.length === CHAT_AVATAR_CACHE_LIMIT - 1) {
          break;
        }
      }
    }
  }
  const previousAvatars = host.senderAgentAvatars;
  // Empty/disconnected batches clear synchronously; only awaited loads need the stale fence.
  const snapshots = ids.length
    ? await Promise.all(ids.map((id) => loadChatAvatarSnapshot(host, id)))
    : [];
  if (
    ids.length &&
    (!connectionIsCurrent() ||
      host.agentsList?.agents !== agents ||
      host.sessionKey !== sessionKey ||
      resolveAgentIdForSession(host) !== agentId ||
      senderAvatarRequests.get(host) !== request)
  ) {
    for (const snapshot of snapshots) {
      snapshot?.release();
    }
    return;
  }
  const references = chatAvatarReferences.get(host);
  for (const [key, release] of references ?? []) {
    if (key !== currentAvatarReference && !ids.includes(key)) {
      release();
      references?.delete(key);
    }
  }
  const avatars = new Map(
    ids.map((id, index) => {
      const snapshot = snapshots[index];
      if (snapshot) {
        rememberChatAvatarReference(host, id, snapshot.release);
        host.cacheChatAvatarSource?.(id, snapshot.source);
      }
      return [id, snapshot ? snapshot.url : (previousAvatars?.get(id) ?? null)];
    }),
  );
  // Identity invalidation and image leases refresh independently; unchanged URLs keep rows memoized.
  if (
    avatars.size !== (previousAvatars?.size ?? 0) ||
    [...avatars].some(([id, url]) => previousAvatars?.get(id) !== url)
  ) {
    host.senderAgentAvatars = avatars;
  }
}

export async function refreshChatAvatar(host: ChatAvatarHost) {
  if (!host.connected) {
    invalidateChatAvatarCache(host);
    return;
  }
  const sessionKey = host.sessionKey;
  const connectionIsCurrent = captureChatConnectionOwner(host);
  const requestVersion = beginChatAvatarRequest(host);
  const agentId = resolveAgentIdForSession(host);
  const showingSameAgent = chatAvatarDisplayedAgents.get(host) === agentId;
  if (!showingSameAgent) {
    clearChatAvatarState(host);
  }
  const snapshot = await loadChatAvatarSnapshot(host, agentId);
  if (
    !connectionIsCurrent() ||
    chatAvatarRequestVersions.get(host) !== requestVersion ||
    host.sessionKey !== sessionKey ||
    resolveAgentIdForSession(host) !== agentId
  ) {
    snapshot?.release();
    return;
  }
  if (snapshot) {
    rememberChatAvatarReference(host, currentAvatarReference, snapshot.release);
    host.chatAvatarStatus = snapshot.status;
    host.chatAvatarReason = snapshot.reason;
    host.chatAvatarUrl = snapshot.url;
    chatAvatarDisplayedAgents.set(host, agentId);
    host.cacheChatAvatarSource?.(agentId, snapshot.source);
  } else if (!showingSameAgent) {
    clearChatAvatarState(host);
  }
}

import { createDedupeCache } from "../infra/dedupe.js";
import {
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import type {
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveButtons,
  PluginInteractiveDiscordHandlerRegistration,
  PluginInteractiveHandlerRegistration,
  PluginInteractiveSlackHandlerContext,
  PluginInteractiveSlackHandlerRegistration,
  PluginInteractiveTelegramHandlerRegistration,
  PluginInteractiveTelegramHandlerContext,
} from "./types.js";

type RegisteredInteractiveHandler = PluginInteractiveHandlerRegistration & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};

type InteractiveRegistrationResult = {
  ok: boolean;
  error?: string;
};

type InteractiveDispatchResult =
  | { matched: false; handled: false; duplicate: false }
  | { matched: true; handled: boolean; duplicate: boolean };

type TelegramInteractiveDispatchContext = Omit<
  PluginInteractiveTelegramHandlerContext,
  | "callback"
  | "respond"
  | "channel"
  | "requestConversationBinding"
  | "detachConversationBinding"
  | "getCurrentConversationBinding"
> & {
  callbackMessage: {
    messageId: number;
    chatId: string;
    messageText?: string;
  };
};

type DiscordInteractiveDispatchContext = Omit<
  PluginInteractiveDiscordHandlerContext,
  | "interaction"
  | "respond"
  | "channel"
  | "requestConversationBinding"
  | "detachConversationBinding"
  | "getCurrentConversationBinding"
> & {
  interaction: Omit<
    PluginInteractiveDiscordHandlerContext["interaction"],
    "data" | "namespace" | "payload"
  >;
};

type SlackInteractiveDispatchContext = Omit<
  PluginInteractiveSlackHandlerContext,
  | "interaction"
  | "respond"
  | "requestConversationBinding"
  | "detachConversationBinding"
  | "getCurrentConversationBinding"
> & {
  interaction: Omit<
    PluginInteractiveSlackHandlerContext["interaction"],
    "data" | "namespace" | "payload"
  >;
};

const interactiveHandlers = new Map<string, RegisteredInteractiveHandler>();
const callbackDedupe = createDedupeCache({
  ttlMs: 5 * 60_000,
  maxSize: 4096,
});

function toRegistryKey(channel: string, namespace: string): string {
  return `${channel.trim().toLowerCase()}:${namespace.trim()}`;
}

function normalizeNamespace(namespace: string): string {
  return namespace.trim();
}

function validateNamespace(namespace: string): string | null {
  if (!namespace.trim()) {
    return "Interactive handler namespace cannot be empty";
  }
  if (!/^[A-Za-z0-9._-]+$/.test(namespace.trim())) {
    return "Interactive handler namespace must contain only letters, numbers, dots, underscores, and hyphens";
  }
  return null;
}

function resolveNamespaceMatch(
  channel: string,
  data: string,
): { registration: RegisteredInteractiveHandler; namespace: string; payload: string } | null {
  const trimmedData = data.trim();
  if (!trimmedData) {
    return null;
  }

  const separatorIndex = trimmedData.indexOf(":");
  const namespace =
    separatorIndex >= 0 ? trimmedData.slice(0, separatorIndex) : normalizeNamespace(trimmedData);
  const registration = interactiveHandlers.get(toRegistryKey(channel, namespace));
  if (!registration) {
    return null;
  }

  return {
    registration,
    namespace,
    payload: separatorIndex >= 0 ? trimmedData.slice(separatorIndex + 1) : "",
  };
}

export function registerPluginInteractiveHandler(
  pluginId: string,
  registration: PluginInteractiveHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string },
): InteractiveRegistrationResult {
  const namespace = normalizeNamespace(registration.namespace);
  const validationError = validateNamespace(namespace);
  if (validationError) {
    return { ok: false, error: validationError };
  }
  const key = toRegistryKey(registration.channel, namespace);
  const existing = interactiveHandlers.get(key);
  if (existing) {
    return {
      ok: false,
      error: `Interactive handler namespace "${namespace}" already registered by plugin "${existing.pluginId}"`,
    };
  }
  if (registration.channel === "telegram") {
    interactiveHandlers.set(key, {
      ...registration,
      namespace,
      channel: "telegram",
      pluginId,
      pluginName: opts?.pluginName,
      pluginRoot: opts?.pluginRoot,
    });
  } else {
    interactiveHandlers.set(key, {
      ...registration,
      namespace,
      channel: "discord",
      pluginId,
      pluginName: opts?.pluginName,
      pluginRoot: opts?.pluginRoot,
    });
  }
  return { ok: true };
}

export function clearPluginInteractiveHandlers(): void {
  interactiveHandlers.clear();
  callbackDedupe.clear();
}

export function clearPluginInteractiveHandlersForPlugin(pluginId: string): void {
  for (const [key, value] of interactiveHandlers.entries()) {
    if (value.pluginId === pluginId) {
      interactiveHandlers.delete(key);
    }
  }
}

export async function dispatchPluginInteractiveHandler(params: {
  channel: "telegram";
  data: string;
  callbackId: string;
  ctx: TelegramInteractiveDispatchContext;
  respond: {
    reply: (params: { text: string; buttons?: PluginInteractiveButtons }) => Promise<void>;
    editMessage: (params: { text: string; buttons?: PluginInteractiveButtons }) => Promise<void>;
    editButtons: (params: { buttons: PluginInteractiveButtons }) => Promise<void>;
    clearButtons: () => Promise<void>;
    deleteMessage: () => Promise<void>;
  };
}): Promise<InteractiveDispatchResult>;
export async function dispatchPluginInteractiveHandler(params: {
  channel: "discord";
  data: string;
  interactionId: string;
  ctx: DiscordInteractiveDispatchContext;
  respond: PluginInteractiveDiscordHandlerContext["respond"];
}): Promise<InteractiveDispatchResult>;
export async function dispatchPluginInteractiveHandler(params: {
  channel: "slack";
  data: string;
  interactionId: string;
  ctx: SlackInteractiveDispatchContext;
  respond: PluginInteractiveSlackHandlerContext["respond"];
}): Promise<InteractiveDispatchResult>;
export async function dispatchPluginInteractiveHandler(params: {
  channel: "telegram" | "discord" | "slack";
  data: string;
  callbackId?: string;
  interactionId?: string;
  ctx:
    | TelegramInteractiveDispatchContext
    | DiscordInteractiveDispatchContext
    | SlackInteractiveDispatchContext;
  respond:
    | {
        reply: (params: { text: string; buttons?: PluginInteractiveButtons }) => Promise<void>;
        editMessage: (params: {
          text: string;
          buttons?: PluginInteractiveButtons;
        }) => Promise<void>;
        editButtons: (params: { buttons: PluginInteractiveButtons }) => Promise<void>;
        clearButtons: () => Promise<void>;
        deleteMessage: () => Promise<void>;
      }
    | PluginInteractiveDiscordHandlerContext["respond"]
    | PluginInteractiveSlackHandlerContext["respond"];
}): Promise<InteractiveDispatchResult> {
  const match = resolveNamespaceMatch(params.channel, params.data);
  if (!match) {
    return { matched: false, handled: false, duplicate: false };
  }

  const dedupeKey =
    params.channel === "telegram" ? params.callbackId?.trim() : params.interactionId?.trim();
  if (dedupeKey && callbackDedupe.peek(dedupeKey)) {
    return { matched: true, handled: true, duplicate: true };
  }

  let result:
    | ReturnType<PluginInteractiveTelegramHandlerRegistration["handler"]>
    | ReturnType<PluginInteractiveDiscordHandlerRegistration["handler"]>
    | ReturnType<PluginInteractiveSlackHandlerRegistration["handler"]>;
  if (params.channel === "telegram") {
    const pluginRoot = match.registration.pluginRoot;
    const { callbackMessage, ...handlerContext } = params.ctx as TelegramInteractiveDispatchContext;
    result = (
      match.registration as RegisteredInteractiveHandler &
        PluginInteractiveTelegramHandlerRegistration
    ).handler({
      ...handlerContext,
      channel: "telegram",
      callback: {
        data: params.data,
        namespace: match.namespace,
        payload: match.payload,
        messageId: callbackMessage.messageId,
        chatId: callbackMessage.chatId,
        messageText: callbackMessage.messageText,
      },
      respond: params.respond as PluginInteractiveTelegramHandlerContext["respond"],
      requestConversationBinding: async (bindingParams) => {
        if (!pluginRoot) {
          return {
            status: "error",
            message: "This interaction cannot bind the current conversation.",
          };
        }
        return requestPluginConversationBinding({
          pluginId: match.registration.pluginId,
          pluginName: match.registration.pluginName,
          pluginRoot,
          requestedBySenderId: handlerContext.senderId,
          conversation: {
            channel: "telegram",
            accountId: handlerContext.accountId,
            conversationId: handlerContext.conversationId,
            parentConversationId: handlerContext.parentConversationId,
            threadId: handlerContext.threadId,
          },
          binding: bindingParams,
        });
      },
      detachConversationBinding: async () => {
        if (!pluginRoot) {
          return { removed: false };
        }
        return detachPluginConversationBinding({
          pluginRoot,
          conversation: {
            channel: "telegram",
            accountId: handlerContext.accountId,
            conversationId: handlerContext.conversationId,
            parentConversationId: handlerContext.parentConversationId,
            threadId: handlerContext.threadId,
          },
        });
      },
      getCurrentConversationBinding: async () => {
        if (!pluginRoot) {
          return null;
        }
        return getCurrentPluginConversationBinding({
          pluginRoot,
          conversation: {
            channel: "telegram",
            accountId: handlerContext.accountId,
            conversationId: handlerContext.conversationId,
            parentConversationId: handlerContext.parentConversationId,
            threadId: handlerContext.threadId,
          },
        });
      },
    });
  } else if (params.channel === "discord") {
    const pluginRoot = match.registration.pluginRoot;
    result = (
      match.registration as RegisteredInteractiveHandler &
        PluginInteractiveDiscordHandlerRegistration
    ).handler({
      ...(params.ctx as DiscordInteractiveDispatchContext),
      channel: "discord",
      interaction: {
        ...(params.ctx as DiscordInteractiveDispatchContext).interaction,
        data: params.data,
        namespace: match.namespace,
        payload: match.payload,
      },
      respond: params.respond as PluginInteractiveDiscordHandlerContext["respond"],
      requestConversationBinding: async (bindingParams) => {
        if (!pluginRoot) {
          return {
            status: "error",
            message: "This interaction cannot bind the current conversation.",
          };
        }
        const handlerContext = params.ctx as DiscordInteractiveDispatchContext;
        return requestPluginConversationBinding({
          pluginId: match.registration.pluginId,
          pluginName: match.registration.pluginName,
          pluginRoot,
          requestedBySenderId: handlerContext.senderId,
          conversation: {
            channel: "discord",
            accountId: handlerContext.accountId,
            conversationId: handlerContext.conversationId,
            parentConversationId: handlerContext.parentConversationId,
          },
          binding: bindingParams,
        });
      },
      detachConversationBinding: async () => {
        if (!pluginRoot) {
          return { removed: false };
        }
        const handlerContext = params.ctx as DiscordInteractiveDispatchContext;
        return detachPluginConversationBinding({
          pluginRoot,
          conversation: {
            channel: "discord",
            accountId: handlerContext.accountId,
            conversationId: handlerContext.conversationId,
            parentConversationId: handlerContext.parentConversationId,
          },
        });
      },
      getCurrentConversationBinding: async () => {
        if (!pluginRoot) {
          return null;
        }
        const handlerContext = params.ctx as DiscordInteractiveDispatchContext;
        return getCurrentPluginConversationBinding({
          pluginRoot,
          conversation: {
            channel: "discord",
            accountId: handlerContext.accountId,
            conversationId: handlerContext.conversationId,
            parentConversationId: handlerContext.parentConversationId,
          },
        });
      },
    });
  } else {
    const pluginRoot = match.registration.pluginRoot;
    const handlerContext = params.ctx as SlackInteractiveDispatchContext;
    result = (
      match.registration as RegisteredInteractiveHandler & PluginInteractiveSlackHandlerRegistration
    ).handler({
      ...handlerContext,
      channel: "slack",
      interaction: {
        ...handlerContext.interaction,
        data: params.data,
        namespace: match.namespace,
        payload: match.payload,
      },
      respond: params.respond as PluginInteractiveSlackHandlerContext["respond"],
      requestConversationBinding: async (bindingParams) => {
        if (!pluginRoot) {
          return {
            status: "error",
            message: "This interaction cannot bind the current conversation.",
          };
        }
        return requestPluginConversationBinding({
          pluginId: match.registration.pluginId,
          pluginName: match.registration.pluginName,
          pluginRoot,
          requestedBySenderId: handlerContext.senderId,
          conversation: {
            channel: "slack",
            accountId: handlerContext.accountId,
            conversationId: handlerContext.conversationId,
            parentConversationId: handlerContext.parentConversationId,
            threadId: handlerContext.threadId,
          },
          binding: bindingParams,
        });
      },
      detachConversationBinding: async () => {
        if (!pluginRoot) {
          return { removed: false };
        }
        return detachPluginConversationBinding({
          pluginRoot,
          conversation: {
            channel: "slack",
            accountId: handlerContext.accountId,
            conversationId: handlerContext.conversationId,
            parentConversationId: handlerContext.parentConversationId,
            threadId: handlerContext.threadId,
          },
        });
      },
      getCurrentConversationBinding: async () => {
        if (!pluginRoot) {
          return null;
        }
        return getCurrentPluginConversationBinding({
          pluginRoot,
          conversation: {
            channel: "slack",
            accountId: handlerContext.accountId,
            conversationId: handlerContext.conversationId,
            parentConversationId: handlerContext.parentConversationId,
            threadId: handlerContext.threadId,
          },
        });
      },
    });
  }
  const resolved = await result;
  if (dedupeKey) {
    callbackDedupe.check(dedupeKey);
  }

  return {
    matched: true,
    handled: resolved?.handled ?? true,
    duplicate: false,
  };
}

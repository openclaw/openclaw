import {
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import type {
  PluginConversationBindingRequestParams,
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveDiscordHandlerRegistration,
  PluginInteractiveSlackHandlerContext,
  PluginInteractiveSlackHandlerRegistration,
  PluginInteractiveTelegramHandlerContext,
  PluginInteractiveTelegramHandlerRegistration,
} from "./types.js";

type RegisteredInteractiveMetadata = {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};

type PluginBindingConversation = Parameters<
  typeof requestPluginConversationBinding
>[0]["conversation"];

export type TelegramInteractiveDispatchContext = Omit<
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

export type DiscordInteractiveDispatchContext = Omit<
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

export type SlackInteractiveDispatchContext = Omit<
  PluginInteractiveSlackHandlerContext,
  | "interaction"
  | "respond"
  | "channel"
  | "requestConversationBinding"
  | "detachConversationBinding"
  | "getCurrentConversationBinding"
> & {
  interaction: Omit<
    PluginInteractiveSlackHandlerContext["interaction"],
    "data" | "namespace" | "payload"
  >;
};

function createConversationBindingHelpers(params: {
  registration: RegisteredInteractiveMetadata;
  senderId?: string;
  conversation: PluginBindingConversation;
}) {
  const { registration, senderId, conversation } = params;
  const pluginRoot = registration.pluginRoot;

  return {
    requestConversationBinding: async (binding: PluginConversationBindingRequestParams = {}) => {
      if (!pluginRoot) {
        return {
          status: "error" as const,
          message: "This interaction cannot bind the current conversation.",
        };
      }
      return requestPluginConversationBinding({
        pluginId: registration.pluginId,
        pluginName: registration.pluginName,
        pluginRoot,
        requestedBySenderId: senderId,
        conversation,
        binding,
      });
    },
    detachConversationBinding: async () => {
      if (!pluginRoot) {
        return { removed: false };
      }
      return detachPluginConversationBinding({
        pluginRoot,
        conversation,
      });
    },
    getCurrentConversationBinding: async () => {
      if (!pluginRoot) {
        return null;
      }
      return getCurrentPluginConversationBinding({
        pluginRoot,
        conversation,
      });
    },
  };
}

export function dispatchTelegramInteractiveHandler(params: {
  registration: PluginInteractiveTelegramHandlerRegistration & RegisteredInteractiveMetadata;
  data: string;
  namespace: string;
  payload: string;
  ctx: TelegramInteractiveDispatchContext;
  respond: PluginInteractiveTelegramHandlerContext["respond"];
}) {
  const { callbackMessage, ...handlerContext } = params.ctx;

  return params.registration.handler({
    ...handlerContext,
    channel: "telegram",
    callback: {
      data: params.data,
      namespace: params.namespace,
      payload: params.payload,
      messageId: callbackMessage.messageId,
      chatId: callbackMessage.chatId,
      messageText: callbackMessage.messageText,
    },
    respond: params.respond,
    ...createConversationBindingHelpers({
      registration: params.registration,
      senderId: handlerContext.senderId,
      conversation: {
        channel: "telegram",
        accountId: handlerContext.accountId,
        conversationId: handlerContext.conversationId,
        parentConversationId: handlerContext.parentConversationId,
        threadId: handlerContext.threadId,
      },
    }),
  });
}

export function dispatchDiscordInteractiveHandler(params: {
  registration: PluginInteractiveDiscordHandlerRegistration & RegisteredInteractiveMetadata;
  data: string;
  namespace: string;
  payload: string;
  ctx: DiscordInteractiveDispatchContext;
  respond: PluginInteractiveDiscordHandlerContext["respond"];
}) {
  const handlerContext = params.ctx;

  return params.registration.handler({
    ...handlerContext,
    channel: "discord",
    interaction: {
      ...handlerContext.interaction,
      data: params.data,
      namespace: params.namespace,
      payload: params.payload,
    },
    respond: params.respond,
    ...createConversationBindingHelpers({
      registration: params.registration,
      senderId: handlerContext.senderId,
      conversation: {
        channel: "discord",
        accountId: handlerContext.accountId,
        conversationId: handlerContext.conversationId,
        parentConversationId: handlerContext.parentConversationId,
      },
    }),
  });
}

export function dispatchSlackInteractiveHandler(params: {
  registration: PluginInteractiveSlackHandlerRegistration & RegisteredInteractiveMetadata;
  data: string;
  namespace: string;
  payload: string;
  ctx: SlackInteractiveDispatchContext;
  respond: PluginInteractiveSlackHandlerContext["respond"];
}) {
  const handlerContext = params.ctx;

  return params.registration.handler({
    ...handlerContext,
    channel: "slack",
    interaction: {
      ...handlerContext.interaction,
      data: params.data,
      namespace: params.namespace,
      payload: params.payload,
    },
    respond: params.respond,
    ...createConversationBindingHelpers({
      registration: params.registration,
      senderId: handlerContext.senderId,
      conversation: {
        channel: "slack",
        accountId: handlerContext.accountId,
        conversationId: handlerContext.conversationId,
        parentConversationId: handlerContext.parentConversationId,
        threadId: handlerContext.threadId,
      },
    }),
  });
}

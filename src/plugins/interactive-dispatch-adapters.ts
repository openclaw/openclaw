import {
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import { createPluginActorRef, createPluginLaneRef } from "./lane-refs.js";
import type {
  PluginConversationBindingRequestParams,
  PluginInteractionCapabilities,
  PluginInteractionHandlerContext,
  PluginInteractionHandlerRegistration,
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
  | "lane"
  | "sender"
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
  | "lane"
  | "sender"
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
  | "lane"
  | "sender"
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

function createGenericInteractionAction(params: {
  data: string;
  namespace: string;
  payload: string;
  kind: PluginInteractionHandlerContext["action"]["kind"];
  values?: string[];
  fields?: Array<{ id: string; name: string; values: string[] }>;
}): PluginInteractionHandlerContext["action"] {
  return {
    raw: params.data,
    namespace: params.namespace,
    payload: params.payload,
    actionId: params.payload || params.namespace,
    kind: params.kind,
    ...(params.values?.length ? { values: params.values } : {}),
    ...(params.fields?.length ? { fields: params.fields } : {}),
  };
}

function createTelegramInteractionCapabilities(): PluginInteractionCapabilities {
  return {
    acknowledge: false,
    followUp: false,
    editText: true,
    clearInteractive: true,
    deleteMessage: true,
  };
}

function createDiscordInteractionCapabilities(): PluginInteractionCapabilities {
  return {
    acknowledge: true,
    followUp: true,
    editText: true,
    clearInteractive: true,
    deleteMessage: false,
  };
}

function createSlackInteractionCapabilities(): PluginInteractionCapabilities {
  return {
    acknowledge: true,
    followUp: true,
    editText: true,
    clearInteractive: true,
    deleteMessage: false,
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
    lane: createPluginLaneRef({
      channel: "telegram",
      to: handlerContext.conversationId,
      accountId: handlerContext.accountId,
      threadId: handlerContext.threadId,
    }) ?? {
      channel: "telegram",
      to: handlerContext.conversationId,
      accountId: handlerContext.accountId,
      ...(handlerContext.threadId != null ? { threadId: handlerContext.threadId } : {}),
    },
    sender: createPluginActorRef({
      channel: "telegram",
      id: handlerContext.senderId,
      accountId: handlerContext.accountId,
      username: handlerContext.senderUsername,
    }),
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

export function dispatchGenericTelegramInteractiveHandler(params: {
  registration: PluginInteractionHandlerRegistration & RegisteredInteractiveMetadata;
  data: string;
  namespace: string;
  payload: string;
  ctx: TelegramInteractiveDispatchContext;
  respond: PluginInteractiveTelegramHandlerContext["respond"];
}) {
  const handlerContext = params.ctx;
  return params.registration.handler({
    channel: "telegram",
    accountId: handlerContext.accountId,
    interactionId: handlerContext.callbackId,
    conversationId: handlerContext.conversationId,
    parentConversationId: handlerContext.parentConversationId,
    lane: createPluginLaneRef({
      channel: "telegram",
      to: handlerContext.conversationId,
      accountId: handlerContext.accountId,
      threadId: handlerContext.threadId,
    }) ?? {
      channel: "telegram",
      to: handlerContext.conversationId,
      accountId: handlerContext.accountId,
      ...(handlerContext.threadId != null ? { threadId: handlerContext.threadId } : {}),
    },
    sender: createPluginActorRef({
      channel: "telegram",
      id: handlerContext.senderId,
      accountId: handlerContext.accountId,
      username: handlerContext.senderUsername,
    }),
    auth: handlerContext.auth,
    action: createGenericInteractionAction({
      data: params.data,
      namespace: params.namespace,
      payload: params.payload,
      kind: "button",
    }),
    capabilities: createTelegramInteractionCapabilities(),
    respond: {
      acknowledge: async () => {},
      replyText: async ({ text }) => params.respond.reply({ text }),
      followUpText: async ({ text }) => params.respond.reply({ text }),
      editText: async ({ text }) =>
        params.respond.editMessage({
          text,
        }),
      clearInteractive: async ({ text } = {}) => {
        if (text?.trim()) {
          await params.respond.editMessage({ text, buttons: [] });
          return;
        }
        await params.respond.clearButtons();
      },
      deleteMessage: async () => {
        await params.respond.deleteMessage();
      },
    },
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
    lane: {
      channel: "discord",
      to: handlerContext.conversationId,
      accountId: handlerContext.accountId,
    },
    sender: createPluginActorRef({
      channel: "discord",
      id: handlerContext.senderId,
      accountId: handlerContext.accountId,
      username: handlerContext.senderUsername,
    }),
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

export function dispatchGenericDiscordInteractiveHandler(params: {
  registration: PluginInteractionHandlerRegistration & RegisteredInteractiveMetadata;
  data: string;
  namespace: string;
  payload: string;
  ctx: DiscordInteractiveDispatchContext;
  respond: PluginInteractiveDiscordHandlerContext["respond"];
}) {
  const handlerContext = params.ctx;
  return params.registration.handler({
    channel: "discord",
    accountId: handlerContext.accountId,
    interactionId: handlerContext.interactionId,
    conversationId: handlerContext.conversationId,
    parentConversationId: handlerContext.parentConversationId,
    lane: {
      channel: "discord",
      to: handlerContext.conversationId,
      accountId: handlerContext.accountId,
    },
    sender: createPluginActorRef({
      channel: "discord",
      id: handlerContext.senderId,
      accountId: handlerContext.accountId,
      username: handlerContext.senderUsername,
    }),
    auth: handlerContext.auth,
    action: createGenericInteractionAction({
      data: params.data,
      namespace: params.namespace,
      payload: params.payload,
      kind:
        handlerContext.interaction.kind === "select" ? "select" : handlerContext.interaction.kind,
      values: handlerContext.interaction.values,
      fields: handlerContext.interaction.fields,
    }),
    capabilities: createDiscordInteractionCapabilities(),
    respond: {
      acknowledge: async () => {
        await params.respond.acknowledge();
      },
      replyText: async ({ text, ephemeral }) => params.respond.reply({ text, ephemeral }),
      followUpText: async ({ text, ephemeral }) => params.respond.followUp({ text, ephemeral }),
      editText: async ({ text }) =>
        text ? params.respond.editMessage({ text }) : params.respond.editMessage({}),
      clearInteractive: async ({ text } = {}) =>
        params.respond.clearComponents(text ? { text } : undefined),
      deleteMessage: async () => {},
    },
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
    lane: {
      channel: "slack",
      to: handlerContext.conversationId,
      accountId: handlerContext.accountId,
      ...(handlerContext.threadId ? { threadId: handlerContext.threadId } : {}),
    },
    sender: createPluginActorRef({
      channel: "slack",
      id: handlerContext.senderId,
      accountId: handlerContext.accountId,
      username: handlerContext.senderUsername,
    }),
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

export function dispatchGenericSlackInteractiveHandler(params: {
  registration: PluginInteractionHandlerRegistration & RegisteredInteractiveMetadata;
  data: string;
  namespace: string;
  payload: string;
  ctx: SlackInteractiveDispatchContext;
  respond: PluginInteractiveSlackHandlerContext["respond"];
}) {
  const handlerContext = params.ctx;
  return params.registration.handler({
    channel: "slack",
    accountId: handlerContext.accountId,
    interactionId: handlerContext.interactionId,
    conversationId: handlerContext.conversationId,
    parentConversationId: handlerContext.parentConversationId,
    lane: {
      channel: "slack",
      to: handlerContext.conversationId,
      accountId: handlerContext.accountId,
      ...(handlerContext.threadId ? { threadId: handlerContext.threadId } : {}),
    },
    sender: createPluginActorRef({
      channel: "slack",
      id: handlerContext.senderId,
      accountId: handlerContext.accountId,
      username: handlerContext.senderUsername,
    }),
    auth: handlerContext.auth,
    action: createGenericInteractionAction({
      data: params.data,
      namespace: params.namespace,
      payload: params.payload,
      kind: handlerContext.interaction.kind === "select" ? "select" : "button",
      values: handlerContext.interaction.selectedValues,
    }),
    capabilities: createSlackInteractionCapabilities(),
    respond: {
      acknowledge: async () => {
        await params.respond.acknowledge();
      },
      replyText: async ({ text, ephemeral }) =>
        params.respond.reply({
          text,
          responseType: ephemeral ? "ephemeral" : "in_channel",
        }),
      followUpText: async ({ text, ephemeral }) =>
        params.respond.followUp({
          text,
          responseType: ephemeral ? "ephemeral" : "in_channel",
        }),
      editText: async ({ text }) =>
        text ? params.respond.editMessage({ text }) : params.respond.editMessage({}),
      clearInteractive: async ({ text } = {}) =>
        text
          ? params.respond.editMessage({ text, blocks: [] })
          : params.respond.editMessage({ blocks: [] }),
      deleteMessage: async () => {},
    },
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

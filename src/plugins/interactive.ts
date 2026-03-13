import { createDedupeCache } from "../infra/dedupe.js";
import type {
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveButtons,
  PluginInteractiveDiscordHandlerRegistration,
  PluginInteractiveHandlerRegistration,
  PluginInteractiveTelegramHandlerRegistration,
  PluginInteractiveTelegramHandlerContext,
} from "./types.js";

type RegisteredInteractiveHandler = PluginInteractiveHandlerRegistration & {
  pluginId: string;
};

type InteractiveRegistrationResult = {
  ok: boolean;
  error?: string;
};

type InteractiveDispatchResult =
  | { matched: false; handled: false; duplicate: false }
  | { matched: true; handled: boolean; duplicate: boolean };

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
    });
  } else {
    interactiveHandlers.set(key, {
      ...registration,
      namespace,
      channel: "discord",
      pluginId,
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
  ctx: Omit<PluginInteractiveTelegramHandlerContext, "callback" | "respond" | "channel"> & {
    callbackMessage: {
      messageId: number;
      chatId: string;
      messageText?: string;
    };
  };
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
  ctx: Omit<PluginInteractiveDiscordHandlerContext, "interaction" | "respond" | "channel"> & {
    interaction: Omit<
      PluginInteractiveDiscordHandlerContext["interaction"],
      "data" | "namespace" | "payload"
    >;
  };
  respond: PluginInteractiveDiscordHandlerContext["respond"];
}): Promise<InteractiveDispatchResult>;
export async function dispatchPluginInteractiveHandler(params: {
  channel: "telegram" | "discord";
  data: string;
  callbackId?: string;
  interactionId?: string;
  ctx:
    | (Omit<PluginInteractiveTelegramHandlerContext, "callback" | "respond" | "channel"> & {
        callbackMessage: {
          messageId: number;
          chatId: string;
          messageText?: string;
        };
      })
    | (Omit<PluginInteractiveDiscordHandlerContext, "interaction" | "respond" | "channel"> & {
        interaction: Omit<
          PluginInteractiveDiscordHandlerContext["interaction"],
          "data" | "namespace" | "payload"
        >;
      });
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
    | PluginInteractiveDiscordHandlerContext["respond"];
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
    | ReturnType<PluginInteractiveDiscordHandlerRegistration["handler"]>;
  if (params.channel === "telegram") {
    const { callbackMessage, ...handlerContext } = params.ctx as Omit<
      PluginInteractiveTelegramHandlerContext,
      "callback" | "respond" | "channel"
    > & {
      callbackMessage: {
        messageId: number;
        chatId: string;
        messageText?: string;
      };
    };
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
    });
  } else {
    result = (
      match.registration as RegisteredInteractiveHandler &
        PluginInteractiveDiscordHandlerRegistration
    ).handler({
      ...(params.ctx as Omit<
        PluginInteractiveDiscordHandlerContext,
        "interaction" | "respond" | "channel"
      > & {
        interaction: Omit<
          PluginInteractiveDiscordHandlerContext["interaction"],
          "data" | "namespace" | "payload"
        >;
      }),
      channel: "discord",
      interaction: {
        ...(
          params.ctx as {
            interaction: Omit<
              PluginInteractiveDiscordHandlerContext["interaction"],
              "data" | "namespace" | "payload"
            >;
          }
        ).interaction,
        data: params.data,
        namespace: match.namespace,
        payload: match.payload,
      },
      respond: params.respond as PluginInteractiveDiscordHandlerContext["respond"],
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

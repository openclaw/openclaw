import {
  dispatchDiscordInteractiveHandler,
  dispatchSlackInteractiveHandler,
  dispatchTelegramInteractiveHandler,
  type DiscordInteractiveDispatchContext,
  type SlackInteractiveDispatchContext,
  type TelegramInteractiveDispatchContext,
} from "./interactive-dispatch-adapters.js";
import { resolvePluginInteractiveNamespaceMatch } from "./interactive-registry.js";
import {
  getPluginInteractiveCallbackDedupeState,
  type RegisteredInteractiveHandler,
} from "./interactive-state.js";
import type {
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveButtons,
  PluginInteractiveDiscordHandlerRegistration,
  PluginInteractiveSlackHandlerContext,
  PluginInteractiveSlackHandlerRegistration,
  PluginInteractiveTelegramHandlerRegistration,
  PluginInteractiveTelegramHandlerContext,
} from "./types.js";

export {
  clearPluginInteractiveHandlers,
  clearPluginInteractiveHandlersForPlugin,
  registerPluginInteractiveHandler,
} from "./interactive-registry.js";
export type { InteractiveRegistrationResult } from "./interactive-registry.js";

type InteractiveDispatchResult =
  | { matched: false; handled: false; duplicate: false }
  | { matched: true; handled: boolean; duplicate: boolean };

const getCallbackDedupe = () => getPluginInteractiveCallbackDedupeState();

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
  onMatched?: () => Promise<void> | void;
}): Promise<InteractiveDispatchResult>;
export async function dispatchPluginInteractiveHandler(params: {
  channel: "discord";
  data: string;
  interactionId: string;
  ctx: DiscordInteractiveDispatchContext;
  respond: PluginInteractiveDiscordHandlerContext["respond"];
  onMatched?: () => Promise<void> | void;
}): Promise<InteractiveDispatchResult>;
export async function dispatchPluginInteractiveHandler(params: {
  channel: "slack";
  data: string;
  interactionId: string;
  ctx: SlackInteractiveDispatchContext;
  respond: PluginInteractiveSlackHandlerContext["respond"];
  onMatched?: () => Promise<void> | void;
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
  onMatched?: () => Promise<void> | void;
}): Promise<InteractiveDispatchResult> {
  const callbackDedupe = getCallbackDedupe();
  const match = resolvePluginInteractiveNamespaceMatch(params.channel, params.data);
  if (!match) {
    return { matched: false, handled: false, duplicate: false };
  }

  const dedupeKey =
    params.channel === "telegram" ? params.callbackId?.trim() : params.interactionId?.trim();
  if (dedupeKey && callbackDedupe.peek(dedupeKey)) {
    return { matched: true, handled: true, duplicate: true };
  }

  await params.onMatched?.();

  let result:
    | ReturnType<PluginInteractiveTelegramHandlerRegistration["handler"]>
    | ReturnType<PluginInteractiveDiscordHandlerRegistration["handler"]>
    | ReturnType<PluginInteractiveSlackHandlerRegistration["handler"]>;
  if (params.channel === "telegram") {
    result = dispatchTelegramInteractiveHandler({
      registration: match.registration as RegisteredInteractiveHandler &
        PluginInteractiveTelegramHandlerRegistration,
      data: params.data,
      namespace: match.namespace,
      payload: match.payload,
      ctx: params.ctx as TelegramInteractiveDispatchContext,
      respond: params.respond as PluginInteractiveTelegramHandlerContext["respond"],
    });
  } else if (params.channel === "discord") {
    result = dispatchDiscordInteractiveHandler({
      registration: match.registration as RegisteredInteractiveHandler &
        PluginInteractiveDiscordHandlerRegistration,
      data: params.data,
      namespace: match.namespace,
      payload: match.payload,
      ctx: params.ctx as DiscordInteractiveDispatchContext,
      respond: params.respond as PluginInteractiveDiscordHandlerContext["respond"],
    });
  } else {
    result = dispatchSlackInteractiveHandler({
      registration: match.registration as RegisteredInteractiveHandler &
        PluginInteractiveSlackHandlerRegistration,
      data: params.data,
      namespace: match.namespace,
      payload: match.payload,
      ctx: params.ctx as SlackInteractiveDispatchContext,
      respond: params.respond as PluginInteractiveSlackHandlerContext["respond"],
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

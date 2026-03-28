import { createDedupeCache, resolveGlobalDedupeCache } from "../infra/dedupe.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  dispatchDiscordInteractiveHandler,
  dispatchMSTeamsInteractiveHandler,
  dispatchSlackInteractiveHandler,
  dispatchTelegramInteractiveHandler,
  type DiscordInteractiveDispatchContext,
  type MSTeamsInteractiveDispatchContext,
  type SlackInteractiveDispatchContext,
  type TelegramInteractiveDispatchContext,
} from "./interactive-dispatch-adapters.js";
import type {
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveButtons,
  PluginInteractiveDiscordHandlerRegistration,
  PluginInteractiveHandlerRegistration,
  PluginInteractiveMSTeamsHandlerContext,
  PluginInteractiveMSTeamsHandlerRegistration,
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

type InteractiveState = {
  interactiveHandlers: Map<string, RegisteredInteractiveHandler>;
  callbackDedupe: ReturnType<typeof createDedupeCache>;
};

const PLUGIN_INTERACTIVE_STATE_KEY = Symbol.for("openclaw.pluginInteractiveState");

const getState = () =>
  resolveGlobalSingleton<InteractiveState>(PLUGIN_INTERACTIVE_STATE_KEY, () => ({
    interactiveHandlers: new Map<string, RegisteredInteractiveHandler>(),
    callbackDedupe: resolveGlobalDedupeCache(
      Symbol.for("openclaw.pluginInteractiveCallbackDedupe"),
      {
        ttlMs: 5 * 60_000,
        maxSize: 4096,
      },
    ),
  }));

const getInteractiveHandlers = () => getState().interactiveHandlers;
const getCallbackDedupe = () => getState().callbackDedupe;

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
  const interactiveHandlers = getInteractiveHandlers();
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
  const interactiveHandlers = getInteractiveHandlers();
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
  } else if (registration.channel === "slack") {
    interactiveHandlers.set(key, {
      ...registration,
      namespace,
      channel: "slack",
      pluginId,
      pluginName: opts?.pluginName,
      pluginRoot: opts?.pluginRoot,
    });
  } else if (registration.channel === "msteams") {
    interactiveHandlers.set(key, {
      ...registration,
      namespace,
      channel: "msteams",
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
  const interactiveHandlers = getInteractiveHandlers();
  const callbackDedupe = getCallbackDedupe();
  interactiveHandlers.clear();
  callbackDedupe.clear();
}

export function clearPluginInteractiveHandlersForPlugin(pluginId: string): void {
  const interactiveHandlers = getInteractiveHandlers();
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
  channel: "msteams";
  data: string;
  interactionId: string;
  ctx: MSTeamsInteractiveDispatchContext;
  respond: PluginInteractiveMSTeamsHandlerContext["respond"];
  onMatched?: () => Promise<void> | void;
}): Promise<InteractiveDispatchResult>;
export async function dispatchPluginInteractiveHandler(params: {
  channel: "telegram" | "discord" | "slack" | "msteams";
  data: string;
  callbackId?: string;
  interactionId?: string;
  ctx:
    | TelegramInteractiveDispatchContext
    | DiscordInteractiveDispatchContext
    | SlackInteractiveDispatchContext
    | MSTeamsInteractiveDispatchContext;
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
    | PluginInteractiveSlackHandlerContext["respond"]
    | PluginInteractiveMSTeamsHandlerContext["respond"];
  onMatched?: () => Promise<void> | void;
}): Promise<InteractiveDispatchResult> {
  const callbackDedupe = getCallbackDedupe();
  const match = resolveNamespaceMatch(params.channel, params.data);
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
    | ReturnType<PluginInteractiveSlackHandlerRegistration["handler"]>
    | ReturnType<PluginInteractiveMSTeamsHandlerRegistration["handler"]>;
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
  } else if (params.channel === "slack") {
    result = dispatchSlackInteractiveHandler({
      registration: match.registration as RegisteredInteractiveHandler &
        PluginInteractiveSlackHandlerRegistration,
      data: params.data,
      namespace: match.namespace,
      payload: match.payload,
      ctx: params.ctx as SlackInteractiveDispatchContext,
      respond: params.respond as PluginInteractiveSlackHandlerContext["respond"],
    });
  } else {
    result = dispatchMSTeamsInteractiveHandler({
      registration: match.registration as RegisteredInteractiveHandler &
        PluginInteractiveMSTeamsHandlerRegistration,
      data: params.data,
      namespace: match.namespace,
      payload: match.payload,
      ctx: params.ctx as MSTeamsInteractiveDispatchContext,
      respond: params.respond as PluginInteractiveMSTeamsHandlerContext["respond"],
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

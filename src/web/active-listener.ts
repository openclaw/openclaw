import { formatCliCommand } from "../cli/command-format.js";
import type { PollInput } from "../polls.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

export type ActiveWebSendOptions = {
  gifPlayback?: boolean;
  accountId?: string;
  fileName?: string;
};

export type ActiveWebListener = {
  sendMessage: (
    to: string,
    text: string,
    mediaBuffer?: Buffer,
    mediaType?: string,
    options?: ActiveWebSendOptions,
  ) => Promise<{ messageId: string }>;
  sendPoll: (to: string, poll: PollInput) => Promise<{ messageId: string }>;
  sendReaction: (
    chatJid: string,
    messageId: string,
    emoji: string,
    fromMe: boolean,
    participant?: string,
  ) => Promise<void>;
  sendComposingTo: (to: string) => Promise<void>;
  close?: () => Promise<void>;
};

// Use Symbol keys to prevent build-time token rewrites and ensure isolation across bundled chunks
const ACTIVE_WEB_LISTENERS_KEY = Symbol.for("openclaw.activeWebListeners");
const ACTIVE_WEB_CURRENT_LISTENER_KEY = Symbol.for("openclaw.activeWebCurrentListener");

type ActiveWebListenerGlobalState = typeof globalThis & {
  [ACTIVE_WEB_LISTENERS_KEY]?: Map<string, ActiveWebListener>;
  [ACTIVE_WEB_CURRENT_LISTENER_KEY]?: ActiveWebListener | null;
};

function getSharedListenersMap(): Map<string, ActiveWebListener> {
  const state = globalThis as ActiveWebListenerGlobalState;
  const existing = state[ACTIVE_WEB_LISTENERS_KEY];
  if (existing) {
    return existing;
  }
  const created = new Map<string, ActiveWebListener>();
  state[ACTIVE_WEB_LISTENERS_KEY] = created;
  return created;
}

const listeners = getSharedListenersMap();
let _currentListener: ActiveWebListener | null =
  (globalThis as ActiveWebListenerGlobalState)[ACTIVE_WEB_CURRENT_LISTENER_KEY] ??
  listeners.get(DEFAULT_ACCOUNT_ID) ??
  null;

export function resolveWebAccountId(accountId?: string | null): string {
  return (accountId ?? "").trim() || DEFAULT_ACCOUNT_ID;
}

export function requireActiveWebListener(accountId?: string | null): {
  accountId: string;
  listener: ActiveWebListener;
} {
  const id = resolveWebAccountId(accountId);
  const listener = listeners.get(id) ?? null;
  if (!listener) {
    throw new Error(
      `No active WhatsApp Web listener (account: ${id}). Start the gateway, then link WhatsApp with: ${formatCliCommand(`openclaw channels login --channel whatsapp --account ${id}`)}.`,
    );
  }
  return { accountId: id, listener };
}

export function setActiveWebListener(listener: ActiveWebListener | null): void;
export function setActiveWebListener(
  accountId: string | null | undefined,
  listener: ActiveWebListener | null,
): void;
export function setActiveWebListener(
  accountIdOrListener: string | ActiveWebListener | null | undefined,
  maybeListener?: ActiveWebListener | null,
): void {
  const { accountId, listener } =
    typeof accountIdOrListener === "string"
      ? { accountId: accountIdOrListener, listener: maybeListener ?? null }
      : {
          accountId: DEFAULT_ACCOUNT_ID,
          listener: accountIdOrListener ?? null,
        };

  const id = resolveWebAccountId(accountId);
  if (!listener) {
    listeners.delete(id);
  } else {
    listeners.set(id, listener);
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    _currentListener = listener;
    (globalThis as ActiveWebListenerGlobalState)[ACTIVE_WEB_CURRENT_LISTENER_KEY] = listener;
  }
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return listeners.get(id) ?? null;
}

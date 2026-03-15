import type { PollInput } from "../polls.js";
import { formatCliCommand } from "../cli/command-format.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

export type ActiveWebSendOptions = {
  gifPlayback?: boolean;
  accountId?: string;
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

const WEB_LISTENER_STATE = Symbol.for("openclaw.webListenerState");

type WebListenerState = {
  listeners: Map<string, ActiveWebListener>;
  currentListener: ActiveWebListener | null;
};

const state: WebListenerState = (() => {
  const g = globalThis as typeof globalThis & {
    [WEB_LISTENER_STATE]?: WebListenerState;
  };
  if (!g[WEB_LISTENER_STATE]) {
    g[WEB_LISTENER_STATE] = {
      listeners: new Map(),
      currentListener: null,
    };
  }
  return g[WEB_LISTENER_STATE];
})();

const listeners = state.listeners;

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
    state.currentListener = listener;
  }
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return listeners.get(id) ?? null;
}

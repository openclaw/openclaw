/**
 * Shared singleton registry for active WhatsApp Web listeners.
 *
 * IMPORTANT: The `listeners` Map is stored on `globalThis` rather than as a
 * module-level variable.  This is necessary because tsdown produces separate
 * builds for core (`src/`) and extensions (`extensions/`), each with its own
 * chunk graph.  A module-level `const listeners = new Map()` would be
 * duplicated into both build outputs, creating two independent Map instances
 * at runtime — the extension's `setActiveWebListener` would write to one Map
 * while the core outbound path's `requireActiveWebListener` would read from
 * another, causing "No active WhatsApp Web listener" errors on cross-session
 * sends.
 *
 * By anchoring the Map on `globalThis`, all copies of this module (regardless
 * of which build output they land in) share the same singleton at runtime.
 *
 * See: https://github.com/openclaw/openclaw/issues/48409
 */

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

const LISTENERS_KEY = Symbol.for("openclaw.whatsapp.activeWebListeners");

function getListenersMap(): Map<string, ActiveWebListener> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[LISTENERS_KEY]) {
    g[LISTENERS_KEY] = new Map<string, ActiveWebListener>();
  }
  return g[LISTENERS_KEY] as Map<string, ActiveWebListener>;
}

export function resolveWebAccountId(accountId?: string | null): string {
  return (accountId ?? "").trim() || DEFAULT_ACCOUNT_ID;
}

export function requireActiveWebListener(accountId?: string | null): {
  accountId: string;
  listener: ActiveWebListener;
} {
  const id = resolveWebAccountId(accountId);
  const listener = getListenersMap().get(id) ?? null;
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
  const listeners = getListenersMap();
  if (!listener) {
    listeners.delete(id);
  } else {
    listeners.set(id, listener);
  }
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return getListenersMap().get(id) ?? null;
}

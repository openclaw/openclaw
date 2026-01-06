import type { PollInput } from "../polls.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

export type ActiveWebSendOptions = {
  gifPlayback?: boolean;
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
  sendComposingTo: (to: string) => Promise<void>;
  close?: () => Promise<void>;
};

let _currentListener: ActiveWebListener | null = null;

const listeners = new Map<string, ActiveWebListener>();

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

  const id = (accountId ?? "").trim() || DEFAULT_ACCOUNT_ID;
  if (!listener) {
    listeners.delete(id);
  } else {
    listeners.set(id, listener);
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    _currentListener = listener;
  }
}

export function getActiveWebListener(
  accountId?: string | null,
): ActiveWebListener | null {
  const id = (accountId ?? "").trim() || DEFAULT_ACCOUNT_ID;
  return listeners.get(id) ?? null;
}

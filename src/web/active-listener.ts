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
  sendComposingTo: (to: string) => Promise<void>;
  close?: () => Promise<void>;
};

let currentListener: ActiveWebListener | null = null;

export function setActiveWebListener(listener: ActiveWebListener | null) {
  currentListener = listener;
}

export function getActiveWebListener(): ActiveWebListener | null {
  return currentListener;
}

/** Captured connection authority, without exposing the authenticated client or handshake. */
export type ControlUiCapturedRequest = {
  request: <T = unknown>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<T>;
  isCurrent: () => boolean;
};
export type ControlUiSetSyncOptions = {
  sync: () => void;
  onAttach?: () => void;
  onDetach?: () => void;
  onSnapshot?: () => void;
  onEvent?: (event: { event: string; payload?: unknown }) => void;
};
export type ControlUiSetSync = {
  readonly attached: boolean;
  readonly requestAcknowledged: boolean;
  resetRetry: () => void;
  scheduleRetry: (callback: () => void) => void;
  sync: () => void;
  schedule: () => void;
  clearRequest: () => void;
  matchesRequest: (signature: string) => boolean;
  isRequestCurrent: () => boolean;
  send: (
    method: string,
    params: unknown,
    signature: string,
    callbacks?: {
      onSuccess?: () => void;
      onError?: () => void;
      onSettled?: (acknowledged: boolean) => void;
    },
  ) => void;
  attach: () => void;
  detach: () => void;
};
export type ControlUiRequests = {
  readonly revision: number;
  hasScope: (scope: "operator.read" | "operator.admin") => boolean;
  capture: () => ControlUiCapturedRequest | null;
  canCall: (
    method: string,
    requiredScope: "operator.read" | "operator.admin",
    requireAdvertisement?: boolean,
  ) => boolean;
  subscribe: (notify: () => void) => () => void;
  subscribeEvents: (notify: (event: { event: string; payload?: unknown }) => void) => () => void;
  /** Reuse the current connection’s canonical Cron inventory invalidation policy. */
  isCronInventoryInvalidation: (event: { event: string; payload?: unknown }) => boolean;
  /** Delegate batching, retries, acknowledgements and visibility to the native lifecycle. */
  createSetSync: (options: ControlUiSetSyncOptions) => ControlUiSetSync;
};

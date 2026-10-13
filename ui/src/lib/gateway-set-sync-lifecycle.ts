import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createGatewayRetryOwner } from "./gateway-retry.ts";

type SetSyncRequest = {
  hello: ApplicationGateway["snapshot"]["hello"];
  signature: string | null;
  controller: AbortController;
  acknowledged: boolean;
};

/** Active consumers own registrations; detached sets skip queued work. */
export function createGatewaySetSyncLifecycle(
  gateway: ApplicationGateway,
  options: {
    sync: () => void;
    onAttach?: () => void;
    onDetach?: () => void;
    onSnapshot?: Parameters<ApplicationGateway["subscribe"]>[0];
    onEvent?: Parameters<ApplicationGateway["subscribeEvents"]>[0];
  },
) {
  const retry = createGatewayRetryOwner();
  let attached = false;
  let scheduled = false;
  let stopSnapshots: (() => void) | null = null;
  let stopEvents: (() => void) | null = null;
  let visibilityDocument: Document | null = null;
  let request: SetSyncRequest | null = null;

  function clearRequest() {
    request?.controller.abort();
    request = null;
  }

  function sync() {
    scheduled = false;
    if (attached) {
      options.sync();
    }
  }

  function schedule() {
    if (!attached || scheduled) {
      return;
    }
    scheduled = true;
    // A same-turn reattach may sync twice; consumers deduplicate the current set.
    globalThis.queueMicrotask(sync);
  }

  const handleVisibilityChange = () => {
    retry.reset();
    schedule();
  };

  return {
    get attached() {
      return attached;
    },
    get retry() {
      return retry;
    },
    sync,
    schedule,
    clearRequest,
    matchesRequest(signature: string) {
      return request?.hello === gateway.snapshot.hello && request?.signature === signature;
    },
    get requestAcknowledged() {
      return request?.acknowledged === true;
    },
    get requestHello() {
      return request?.hello ?? null;
    },
    send(
      client: NonNullable<ApplicationGateway["snapshot"]["client"]>,
      method: string,
      params: unknown,
      signature: string,
      callbacks: {
        onSuccess?: () => void;
        onError?: () => void;
        onSettled?: (acknowledged: boolean) => void;
      } = {},
    ) {
      clearRequest();
      const attempt: SetSyncRequest = {
        hello: gateway.snapshot.hello,
        signature,
        controller: new AbortController(),
        acknowledged: false,
      };
      request = attempt;
      // Navigation and reconnects retire the whole attempt, including its callbacks.
      const isCurrent = () => attached && request === attempt;
      retry.cancel();
      void client
        .request(method, params, {
          timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
          signal: attempt.controller.signal,
        })
        .then(() => {
          if (isCurrent()) {
            attempt.acknowledged = true;
            retry.reset();
            callbacks.onSuccess?.();
          }
        })
        .catch(() => {
          if (isCurrent()) {
            attempt.signature = null;
            callbacks.onError?.();
          }
        })
        .finally(() => {
          if (isCurrent()) {
            callbacks.onSettled?.(attempt.signature !== null);
          }
        });
    },
    attach() {
      if (attached) {
        return;
      }
      attached = true;
      options.onAttach?.();
      stopSnapshots = gateway.subscribe(options.onSnapshot ?? schedule);
      stopEvents = options.onEvent ? gateway.subscribeEvents(options.onEvent) : null;
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", handleVisibilityChange);
        visibilityDocument = document;
      }
    },
    detach() {
      if (!attached) {
        return;
      }
      attached = false;
      clearRequest();
      stopSnapshots?.();
      stopSnapshots = null;
      stopEvents?.();
      stopEvents = null;
      visibilityDocument?.removeEventListener("visibilitychange", handleVisibilityChange);
      visibilityDocument = null;
      retry.reset();
      scheduled = false;
      options.onDetach?.();
    },
  };
}

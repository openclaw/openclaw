import { createChangeListeners } from "../../../src/shared/listeners.js";
import {
  isStaleChunkImportError,
  cancelStaleChunkRecovery,
  retryStaleChunkReloadWhenReachable,
} from "./stale-chunk-reload.ts";

type CustomElementModuleLoader = () => Promise<unknown>;

const pendingLoads = new Map<string, Promise<void>>();

/** Load a custom-element module once and verify that it registered its tag. */
export function ensureCustomElementDefined(
  tagName: string,
  loadModule: CustomElementModuleLoader,
): Promise<void> {
  if (customElements.get(tagName)) {
    return Promise.resolve();
  }
  const pending = pendingLoads.get(tagName);
  if (pending) {
    return pending;
  }
  const load = Promise.resolve()
    .then(loadModule)
    .then(() => {
      if (!customElements.get(tagName)) {
        throw new Error(`Custom element module did not define ${tagName}`);
      }
    })
    .finally(() => {
      pendingLoads.delete(tagName);
    });
  pendingLoads.set(tagName, load);
  return load;
}

export type OptionalCustomElement = {
  tagName: string;
  label: string;
  loadModule: CustomElementModuleLoader;
};

type RenderHost = {
  readonly updateComplete?: Promise<unknown>;
  /**
   * Render-root lookup used to gate action replay on the element actually
   * being rendered. Hosts without it replay unconditionally.
   */
  queryRenderedElement?: (tagName: string) => Element | null;
};

type LazyCustomElementRequestState =
  | { status: "loading"; element: OptionalCustomElement }
  | {
      status: "error";
      element: OptionalCustomElement;
      error: unknown;
      stale: boolean;
    };

type LazyCustomElementRequest = LazyCustomElementRequestState & {
  action?: () => void;
};

/** Owns visible lazy-element requests while global registration stays deduplicated by tag. */
export function createLazyCustomElementRequests(
  host: RenderHost = {},
  onClose?: () => void,
  retryStale = (canReload: () => boolean) => retryStaleChunkReloadWhenReachable({ canReload }),
) {
  let current: LazyCustomElementRequest | undefined;
  const preloads = new Set<string>();
  let activeElement: OptionalCustomElement | undefined;
  let activeDismissed = false;
  let staleRetry: LazyCustomElementRequest | undefined;
  const listeners = createChangeListeners();
  const notify = listeners.publish;

  function preload(element: OptionalCustomElement, options?: { reportError?: boolean }): void {
    if (isOptionalElementDefined(element) || preloads.has(element.tagName)) {
      return;
    }
    preloads.add(element.tagName);
    void ensureCustomElementDefined(element.tagName, element.loadModule)
      .then(
        () => notify(),
        (error: unknown) => {
          if (options?.reportError && !current) {
            current = {
              element,
              error,
              stale: isStaleChunkImportError(error),
              status: "error",
            };
            notify();
          }
        },
      )
      .finally(() => preloads.delete(element.tagName));
  }

  function requestElement(element: OptionalCustomElement, action?: () => void): void {
    const request = {
      action,
      element,
      status: "loading",
    } satisfies LazyCustomElementRequest;
    current = request;
    notify();
    load(request);
  }

  function requestWhileActive(element: OptionalCustomElement, active: boolean): void {
    if (active) {
      if (activeElement !== element) {
        activeElement = element;
        activeDismissed = false;
      }
    } else if (activeElement === element) {
      activeElement = undefined;
      activeDismissed = false;
    }
    if (!active && current?.element === element) {
      abandon();
    } else {
      pumpActive();
    }
  }

  function retry(): void {
    const request = current;
    if (request?.status !== "error") {
      return;
    }
    const retryRequest = {
      action: request.action,
      element: request.element,
      status: "loading",
    } satisfies LazyCustomElementRequest;
    current = retryRequest;
    staleRetry = request.stale ? retryRequest : undefined;
    notify();
    const canReload = () => current === retryRequest;
    void (request.stale ? retryStale(canReload) : Promise.resolve(false)).then((reloading) => {
      if (!reloading && current === retryRequest) {
        load(retryRequest);
      }
    });
  }

  function close(): void {
    if (current) {
      if (current.element === activeElement) {
        activeDismissed = true;
      }
      onClose?.();
      abandon();
    }
  }

  function abandon(): void {
    if (current) {
      // A retired stale-chunk failure must not reload the page later (#130988);
      // surfaces that still show a failure re-arm recovery when they render.
      if ((current.status === "error" && current.stale) || current === staleRetry) {
        cancelStaleChunkRecovery();
      }
      current = undefined;
      notify();
      pumpActive();
    }
  }

  function pumpActive(): void {
    if (activeElement && !activeDismissed && !current && !isOptionalElementDefined(activeElement)) {
      requestElement(activeElement);
    }
  }

  function load(request: LazyCustomElementRequest): void {
    void ensureCustomElementDefined(request.element.tagName, request.element.loadModule).then(
      async () => {
        // Registration outlives dismissal; mount the closed element so the next open works.
        notify();
        if (current !== request) {
          return;
        }
        await host.updateComplete;
        if (current === request) {
          // Replay only once the host has actually rendered the element.
          // During boot the shell can still be splash-gated after this update;
          // replaying then re-dispatches an event nothing handles, which
          // re-enters this loader in a microtask cycle that starves the
          // render (and the Gateway socket) forever. The skipped action stays
          // persisted as the pending lazy shell action and replays through
          // restorePendingLazyAction on a later context update.
          const replayable =
            !host.queryRenderedElement ||
            host.queryRenderedElement(request.element.tagName) !== null;
          if (replayable) {
            request.action?.();
          }
          if (current === request) {
            abandon();
          }
        }
      },
      (error: unknown) => {
        if (current !== request) {
          return;
        }
        current = {
          action: request.action,
          element: request.element,
          error,
          stale: isStaleChunkImportError(error),
          status: "error",
        };
        notify();
      },
    );
  }

  return {
    get visibleState(): LazyCustomElementRequestState | undefined {
      return current;
    },
    subscribe: listeners.subscribe,
    preload,
    request: requestElement,
    requestWhileActive,
    retry,
    close,
    abandon,
  };
}

export function isOptionalElementDefined(element: OptionalCustomElement): boolean {
  return customElements.get(element.tagName) !== undefined;
}

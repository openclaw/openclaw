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

type LazyCustomElementRequestState =
  | { status: "loading"; element: OptionalCustomElement }
  | {
      status: "error";
      element: OptionalCustomElement;
      error: unknown;
      stale: boolean;
    };

/** Owns visible lazy-element requests while global registration stays deduplicated by tag. */
export function createLazyCustomElementRequests() {
  let current: LazyCustomElementRequestState | undefined;
  let activeElement: OptionalCustomElement | undefined;
  let staleRetry: LazyCustomElementRequestState | undefined;
  const listeners = createChangeListeners();
  const notify = listeners.publish;

  function requestElement(element: OptionalCustomElement): void {
    const request = {
      element,
      status: "loading",
    } satisfies LazyCustomElementRequestState;
    current = request;
    notify();
    load(request);
  }

  function requestWhileActive(element: OptionalCustomElement, active: boolean): void {
    if (active) {
      activeElement = element;
    } else if (activeElement === element) {
      activeElement = undefined;
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
      element: request.element,
      status: "loading",
    } satisfies LazyCustomElementRequestState;
    current = retryRequest;
    staleRetry = request.stale ? retryRequest : undefined;
    notify();
    const canReload = () => current === retryRequest;
    void (
      request.stale ? retryStaleChunkReloadWhenReachable({ canReload }) : Promise.resolve(false)
    ).then((reloading) => {
      if (!reloading && current === retryRequest) {
        load(retryRequest);
      }
    });
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
    if (activeElement && !current && !isOptionalElementDefined(activeElement)) {
      requestElement(activeElement);
    }
  }

  function load(request: LazyCustomElementRequestState): void {
    void ensureCustomElementDefined(request.element.tagName, request.element.loadModule).then(
      () => {
        // Registration outlives deactivation; publish it for the next active render.
        notify();
        if (current === request) {
          abandon();
        }
      },
      (error: unknown) => {
        if (current !== request) {
          return;
        }
        current = {
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
    requestWhileActive,
    retry,
  };
}

export function isOptionalElementDefined(element: OptionalCustomElement): boolean {
  return customElements.get(element.tagName) !== undefined;
}

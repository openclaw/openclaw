import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { normalizeApplicationContext } from "./application-context-fixtures.ts";

export {
  createApplicationGateway,
  createNavigationPreferencesFixture,
  hiddenScopeUpgradeCapability,
} from "./application-context-fixtures.ts";

type ContextCallback = (value: ApplicationContext, unsubscribe?: () => void) => void;
type ContextRequest = Event & {
  context: unknown;
  contextTarget: Element;
  callback: ContextCallback;
  subscribe?: boolean;
};

/** Plain-DOM fixture for callers still crossing the application context bridge. */
export function requestApplicationContext(
  host: Element,
  callback: ContextCallback,
  subscribe = false,
) {
  host.dispatchEvent(
    Object.assign(new Event("context-request", { bubbles: true, composed: true }), {
      context: applicationContext,
      contextTarget: host,
      callback,
      subscribe,
    }),
  );
}

export function createApplicationContextProvider(context: ApplicationContext) {
  const host = document.createElement("div");
  let current = normalizeApplicationContext(context);
  const subscribers = new Map<ContextCallback, () => void>();
  host.addEventListener("context-request", (event) => {
    // SAFETY: The context-request protocol defines these properties on its DOM event.
    const request = event as ContextRequest;
    if (request.context !== applicationContext || request.contextTarget === host) {
      return;
    }
    event.stopPropagation();
    if (request.subscribe) {
      const unsubscribe = () => subscribers.delete(request.callback);
      subscribers.set(request.callback, unsubscribe);
      request.callback(current, unsubscribe);
    } else {
      request.callback(current);
    }
  });
  return Object.assign(host, {
    setContext(this: void, value: ApplicationContext) {
      const next = normalizeApplicationContext(value);
      if (next === current) {
        return;
      }
      current = next;
      for (const [callback, unsubscribe] of subscribers) {
        callback(current, unsubscribe);
      }
    },
  });
}

export type ApplicationContextProvider = ReturnType<typeof createApplicationContextProvider>;

import { ContextNotFoundError } from "@solidjs/signals";
import type { JSX } from "@solidjs/web";
import {
  createComponent,
  createContext,
  createRenderEffect,
  onCleanup,
  untrack,
  useContext,
} from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { applicationContext, type ApplicationContextRequest } from "../../app/context.ts";
import { listen } from "./listener.ts";

/** The existing capability object; providing it never transfers owner lifetimes. */
const ApplicationContext = createContext<ApplicationContext>();

/** Solid owns the context; a native host transports it to independently upgraded elements. */
export function ApplicationProvider(props: {
  value: ApplicationContext;
  children?: JSX.Element;
  host?: HTMLElement;
}): JSX.Element {
  // The native transport belongs to this mounted host; the capability value stays reactive.
  const host = untrack(() => props.host);
  if (host) {
    const subscribers = new Map<
      ApplicationContextRequest["callback"],
      { target: HTMLElement; unsubscribe: () => void }
    >();
    const request = (event: Event) => {
      // SAFETY: The native request protocol is identified by the context token below.
      const incoming = event as ApplicationContextRequest;
      if (incoming.context !== applicationContext || incoming.contextTarget === host) {
        return;
      }
      event.stopPropagation();
      let subscription = subscribers.get(incoming.callback);
      if (incoming.subscribe && !subscription) {
        subscription = {
          target: incoming.contextTarget,
          unsubscribe: () => {
            subscribers.delete(incoming.callback);
          },
        };
        subscribers.set(incoming.callback, subscription);
      }
      incoming.callback(
        untrack(() => props.value),
        subscription?.unsubscribe,
      );
    };
    const provider = (event: Event) => {
      // SAFETY: Provider announcements carry the same context token as requests.
      const incoming = event as Event & { context?: unknown; contextTarget?: HTMLElement };
      if (incoming.context !== applicationContext || incoming.contextTarget === host) {
        return;
      }
      for (const [callback, subscription] of subscribers) {
        if (
          incoming.contextTarget !== subscription.target &&
          incoming.contextTarget?.contains(subscription.target)
        ) {
          subscribers.delete(callback);
          subscription.target.dispatchEvent(
            Object.assign(new Event("context-request", { bubbles: true, composed: true }), {
              context: applicationContext,
              contextTarget: subscription.target,
              callback,
              subscribe: true,
            }),
          );
        }
      }
    };
    const stopRequest = listen(host, "context-request", request);
    const stopProvider = listen(host, "context-provider", provider);
    createRenderEffect(
      () => props.value,
      (value) => {
        for (const [callback, subscription] of subscribers) {
          callback(value, subscription.unsubscribe);
        }
      },
    );
    onCleanup(() => {
      stopRequest();
      stopProvider();
      subscribers.clear();
    });
    host.dispatchEvent(
      Object.assign(new Event("context-provider", { bubbles: true, composed: true }), {
        context: applicationContext,
        contextTarget: host,
      }),
    );
  }
  return createComponent(ApplicationContext, {
    // Solid context snapshots this capability; native transport above owns replacements.
    value: untrack(() => props.value),
    get children() {
      return props.children;
    },
  });
}

export function useApplication(): ApplicationContext {
  return useContext(ApplicationContext);
}

/** Standalone leaves can render without application-owned capabilities. */
export function useOptionalApplication(): ApplicationContext | undefined {
  try {
    return useApplication();
  } catch (error) {
    if (!(error instanceof ContextNotFoundError)) {
      throw error;
    }
    return undefined;
  }
}

import type { ApplicationContext } from "../../app/context-types.ts";
import { projectSource } from "./projection.ts";

type Subscription = {
  listeners: Set<() => void>;
  release: () => void;
};

const subscriptions = new WeakMap<ApplicationContext, Subscription>();

function subscribeContext(context: ApplicationContext | undefined, notify: () => void) {
  if (!context) {
    return () => {};
  }
  let subscription = subscriptions.get(context);
  if (!subscription) {
    const listeners = new Set<() => void>();
    const publish = () => {
      for (const listener of listeners) {
        listener();
      }
    };
    const stops = [context.agents, context.agentIdentity, context.gateway].map((source) =>
      source.subscribe(publish),
    );
    subscription = { listeners, release: () => stops.forEach((stop) => stop()) };
    subscriptions.set(context, subscription);
  }
  subscription.listeners.add(notify);
  const current = subscription;
  return () => {
    if (current.listeners.delete(notify) && current.listeners.size === 0) {
      current.release();
      subscriptions.delete(context);
    }
  };
}

/** Rows share upstream observation by application; each projection keeps its own lifetime. */
export function projectAgentRowContext(context: ApplicationContext | undefined) {
  return projectSource(context, {
    read: (source) => source,
    subscribe: subscribeContext,
    equality: "revision",
  });
}

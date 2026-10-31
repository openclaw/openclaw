/// <reference lib="es2024.collection" />

import { createEffect, createMemo, createSignal, onSettled } from "solid-js";

type ObserverTargets = readonly Element[];

type NativeObserver = {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
};

/** One native delivery retains each subscriber's entry batch and independent lifetime. */
function observerPool<E extends { target: Element }, O extends NativeObserver>(
  create: (deliver: (entries: E[], observer: O) => void) => O,
  empty: () => void,
) {
  type Subscription = { callback: (entries: E[], observer: O) => void; active: boolean };
  const targets = new Map<Element, Set<Subscription>>();
  const latest = new Map<Element, E>();
  let deliveredObserver: O | undefined;
  const observer = create((entries, native) => {
    deliveredObserver = native;
    const deliveries = new Map<Subscription, E[]>();
    for (const entry of entries) {
      if (targets.has(entry.target)) {
        latest.set(entry.target, entry);
      }
      for (const subscription of targets.get(entry.target) ?? []) {
        const batch = deliveries.get(subscription);
        if (batch) {
          batch.push(entry);
        } else {
          deliveries.set(subscription, [entry]);
        }
      }
    }
    for (const [subscription, batch] of deliveries) {
      if (subscription.active) {
        try {
          subscription.callback(batch, native);
        } catch (error) {
          // Separate native observers isolate callback failures from other consumers.
          reportError(error);
        }
      }
    }
  });
  return (elements: ObserverTargets, callback: Subscription["callback"]) => {
    const subscription = { callback, active: true };
    for (const element of elements) {
      let subscriptions = targets.get(element);
      if (!subscriptions) {
        subscriptions = new Set();
        targets.set(element, subscriptions);
        observer.observe(element);
      }
      subscriptions.add(subscription);
    }
    // Native observers report initial state once per target. A later subscriber
    // also needs that state, without resetting the other subscribers' observation.
    const initial = elements.flatMap((element) => latest.get(element) ?? []);
    if (initial.length) {
      queueMicrotask(() => {
        const entries = initial.filter((entry) => latest.get(entry.target) === entry);
        if (subscription.active && entries.length && deliveredObserver) {
          callback(entries, deliveredObserver);
        }
      });
    }
    return () => {
      if (!subscription.active) {
        return;
      }
      subscription.active = false;
      for (const element of elements) {
        const subscriptions = targets.get(element);
        subscriptions?.delete(subscription);
        if (subscriptions?.size === 0) {
          observer.unobserve(element);
          targets.delete(element);
          latest.delete(element);
        }
      }
      if (targets.size === 0) {
        observer.disconnect();
        empty();
      }
    };
  };
}

type ResizePool = ReturnType<typeof observerPool<ResizeObserverEntry, ResizeObserver>>;
type IntersectionPool = ReturnType<
  typeof observerPool<IntersectionObserverEntry, IntersectionObserver>
>;
const resizePools = new WeakMap<Document, Map<ResizeObserverBoxOptions, ResizePool>>();
const intersectionPools = new WeakMap<
  Document,
  Map<Element | Document | null, Map<string, IntersectionPool>>
>();

export function observeResize(
  elements: ObserverTargets,
  callback: ResizeObserverCallback,
  options?: ResizeObserverOptions,
) {
  const releases: (() => void)[] = [];
  const documents = Map.groupBy(elements, (element) => element.ownerDocument);
  for (const [document, targets] of documents) {
    let pools = resizePools.get(document);
    if (!pools) {
      pools = new Map();
      resizePools.set(document, pools);
    }
    const box = options?.box ?? "content-box";
    let pool = pools.get(box);
    if (!pool) {
      pool = observerPool<ResizeObserverEntry, ResizeObserver>(
        (deliver) => {
          const observer = new ResizeObserver(deliver);
          return {
            observe: (element) => observer.observe(element, { box }),
            unobserve: (element) => observer.unobserve(element),
            disconnect: () => observer.disconnect(),
          };
        },
        () => pools.delete(box),
      );
      pools.set(box, pool);
    }
    releases.push(pool(targets, callback));
  }
  return () => releases.forEach((release) => release());
}

export function observeIntersection(
  elements: ObserverTargets,
  callback: IntersectionObserverCallback,
  options: IntersectionObserverInit = {},
) {
  const releases: (() => void)[] = [];
  for (const [document, targets] of Map.groupBy(elements, (element) => element.ownerDocument)) {
    let roots = intersectionPools.get(document);
    if (!roots) {
      roots = new Map();
      intersectionPools.set(document, roots);
    }
    const root = options.root ?? null;
    let pools = roots.get(root);
    if (!pools) {
      pools = new Map();
      roots.set(root, pools);
    }
    const key = JSON.stringify({ ...options, root: undefined });
    let pool = pools.get(key);
    if (!pool) {
      pool = observerPool<IntersectionObserverEntry, IntersectionObserver>(
        (deliver) => new IntersectionObserver(deliver, options),
        () => {
          pools.delete(key);
          if (pools.size === 0) {
            roots.delete(root);
          }
        },
      );
      pools.set(key, pool);
    }
    releases.push(pool(targets, callback));
  }
  return () => releases.forEach((release) => release());
}

function mountedTargets(targets: () => ObserverTargets) {
  const [mounted, setMounted] = createSignal(false);
  onSettled(() => {
    setMounted(true);
  });
  // Effect compute runs during setup too; refs are only safe after settlement.
  return createMemo(() => (mounted() ? targets() : []));
}

/** Observe after refs attach; replacement and owner disposal disconnect the old observer. */
export function createResizeObserver(
  targets: () => ObserverTargets,
  callback: ResizeObserverCallback,
  options?: ResizeObserverOptions,
) {
  createEffect(mountedTargets(targets), (current) => {
    if (current.length === 0 || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    return observeResize(current, callback, options);
  });
}

/** Intersection policy stays with the caller; this primitive owns only observation lifetime. */
export function createIntersectionObserver(
  targets: () => ObserverTargets,
  callback: IntersectionObserverCallback,
  options?: IntersectionObserverInit,
) {
  createEffect(mountedTargets(targets), (current) => {
    if (current.length === 0 || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    return observeIntersection(current, callback, options);
  });
}

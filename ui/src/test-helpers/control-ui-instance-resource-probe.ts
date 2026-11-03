import {
  installControlUiResourceCounts,
  type ControlUiResourceCounts,
} from "../../../scripts/lib/control-ui-resource-counts.ts";
import { createProjectionResourceProbe } from "./control-ui-projection-resource-probe.ts";

type InstanceEventCount = {
  created: number;
  active: number;
  callbacks: number;
  dispatched: number;
};
export type InstanceNativeCheckpoint = {
  phase: string;
  native: ControlUiResourceCounts;
  events: Record<string, InstanceEventCount>;
};

/** Explicit benchmark document only. Never called or constructed by CPU runs. */
export function createInstanceResourceProbe() {
  const undo: Array<() => void> = [];
  const save = (target: object, key: PropertyKey) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    undo.push(() =>
      descriptor
        ? Object.defineProperty(target, key, descriptor)
        : Reflect.deleteProperty(target, key),
    );
  };
  for (const key of [
    "MutationObserver",
    "IntersectionObserver",
    "ResizeObserver",
    "matchMedia",
    "setTimeout",
    "setInterval",
    "clearInterval",
    "clearTimeout",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "requestIdleCallback",
    "cancelIdleCallback",
    "openclawResourceCounts",
  ] as const) {
    save(window, key);
  }
  for (const target of [window, document, document.fonts]) {
    save(target, "addEventListener");
    save(target, "removeEventListener");
  }
  installControlUiResourceCounts();
  const sources = createProjectionResourceProbe();
  const events: Record<string, InstanceEventCount> = {};
  const track = (target: EventTarget, label: string, types: readonly string[]) => {
    save(target, "addEventListener");
    save(target, "removeEventListener");
    save(target, "dispatchEvent");
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    const dispatch = target.dispatchEvent.bind(target);
    type Entry = {
      type: string;
      listener: EventListenerOrEventListenerObject;
      capture: boolean;
      wrapped: EventListener;
      retire: () => void;
    };
    const entries: Entry[] = [];
    target.addEventListener = (type, listener, options) => {
      if (
        !types.includes(type) ||
        !listener ||
        (typeof options === "object" && options.signal?.aborted)
      ) {
        return add(type, listener, options);
      }
      const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
      const existing = entries.find(
        (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
      );
      if (existing) {
        return add(type, existing.wrapped, options);
      }
      const signal = typeof options === "object" ? options.signal : undefined;
      const once = typeof options === "object" && options.once;
      const counts = (events[`${label}.${type}`] ??= {
        created: 0,
        active: 0,
        callbacks: 0,
        dispatched: 0,
      });
      const entry: Entry = {
        type,
        listener,
        capture,
        wrapped(event) {
          if (once) {
            entry.retire();
          }
          counts.callbacks++;
          if (typeof listener === "function") {
            listener.call(this, event);
          } else {
            listener.handleEvent(event);
          }
        },
        retire() {
          const index = entries.indexOf(entry);
          if (index < 0) {
            return;
          }
          entries.splice(index, 1);
          counts.active--;
          signal?.removeEventListener("abort", entry.retire);
        },
      };
      add(type, entry.wrapped, options);
      counts.created++;
      counts.active++;
      entries.push(entry);
      signal?.addEventListener("abort", entry.retire, { once: true });
    };
    target.removeEventListener = (type, listener, options) => {
      const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
      const entry = entries.find(
        (candidate) =>
          candidate.type === type &&
          candidate.listener === listener &&
          candidate.capture === capture,
      );
      entry?.retire();
      remove(type, entry?.wrapped ?? listener, options);
    };
    target.dispatchEvent = (event) => {
      if (types.includes(event.type)) {
        (events[`${label}.${event.type}`] ??= {
          created: 0,
          active: 0,
          callbacks: 0,
          dispatched: 0,
        }).dispatched++;
      }
      return dispatch(event);
    };
  };
  track(window, "window", [
    "openclaw:link-reader-metadata-request",
    "openclaw:link-reader-metadata-updated",
    "focus",
  ]);
  track(document, "document", ["visibilitychange"]);
  return {
    sources,
    native(phase: string): InstanceNativeCheckpoint {
      const read: unknown = Reflect.get(window, "openclawResourceCounts");
      if (typeof read !== "function") {
        throw new Error("Native resource counter is missing");
      }
      return { phase, native: read(), events: structuredClone(events) };
    },
    dispose() {
      sources.dispose();
      for (const restore of undo.toReversed()) {
        restore();
      }
    },
  };
}

type ProjectionSourceCounts = {
  subscribeCalls: number;
  active: number;
  peak: number;
  callbacks: number;
  cleanupCalls: number;
};
type ProjectionScanCounts = { calls: number; visits: number; duringNativeCallback: number };
export type ProjectionResourceSnapshot = {
  sources: Record<string, ProjectionSourceCounts>;
  scans: Record<string, ProjectionScanCounts>;
};

/** Benchmark-only native-boundary instrumentation; never constructed in CPU mode. */
export function createProjectionResourceProbe() {
  const sources: ProjectionResourceSnapshot["sources"] = {};
  const scans: ProjectionResourceSnapshot["scans"] = {};
  const restore: Array<() => void> = [];
  const arrays = new WeakSet<object>();
  let nativeCallbackDepth = 0;
  const methods: Record<string, { calls: number; duringNativeCallback: number }> = {};

  function observeMethod(source: object, method: string, label: string) {
    const descriptor = Object.getOwnPropertyDescriptor(source, method);
    const original: unknown = Reflect.get(source, method);
    if (typeof original !== "function") {
      throw new Error(`Missing native method: ${label}`);
    }
    const counts = (methods[label] ??= { calls: 0, duringNativeCallback: 0 });
    Object.defineProperty(source, method, {
      configurable: true,
      writable: true,
      value(this: unknown, ...args: unknown[]) {
        counts.calls++;
        counts.duringNativeCallback += Number(nativeCallbackDepth > 0);
        return Reflect.apply(original, this, args);
      },
    });
    restore.push(() => {
      if (descriptor) {
        Object.defineProperty(source, method, descriptor);
      } else {
        Reflect.deleteProperty(source, method);
      }
    });
  }

  function observeWidgets(widgets: readonly unknown[], label: string) {
    if (arrays.has(widgets)) {
      return;
    }
    arrays.add(widgets);
    for (const method of ["some", "map"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(widgets, method);
      const original = widgets[method];
      const counts = (scans[`${label}.${method}`] ??= {
        calls: 0,
        visits: 0,
        duringNativeCallback: 0,
      });
      Object.defineProperty(widgets, method, {
        configurable: true,
        writable: true,
        value(this: readonly unknown[], ...args: unknown[]) {
          counts.calls++;
          const callback = args[0];
          if (typeof callback === "function") {
            args[0] = function (this: unknown, ...values: unknown[]) {
              counts.visits++;
              counts.duringNativeCallback += Number(nativeCallbackDepth > 0);
              return Reflect.apply(callback, this, values);
            };
          }
          return Reflect.apply(original, this, args);
        },
      });
      restore.push(() => {
        if (descriptor) {
          Object.defineProperty(widgets, method, descriptor);
        } else {
          Reflect.deleteProperty(widgets, method);
        }
      });
    }
  }

  function observeSource(
    source: object,
    label: string,
    beforeDelivery?: () => void,
    method: "subscribe" | "subscribeEvents" = "subscribe",
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(source, method);
    const original: unknown = Reflect.get(source, method);
    if (typeof original !== "function") {
      throw new Error(`Missing native subscription boundary: ${label}`);
    }
    const counts = (sources[label] ??= {
      subscribeCalls: 0,
      active: 0,
      peak: 0,
      callbacks: 0,
      cleanupCalls: 0,
    });
    // Preserve Set-style duplicate callback identity at the native boundary.
    const entries = new WeakMap<
      object,
      { callback: (...args: unknown[]) => unknown; active: boolean }
    >();
    Object.defineProperty(source, method, {
      configurable: true,
      writable: true,
      value(this: unknown, ...args: unknown[]) {
        const listener = args[0];
        if (typeof listener !== "function") {
          return Reflect.apply(original, this, args);
        }
        let entry = entries.get(listener);
        if (!entry) {
          entry = {
            active: false,
            callback(this: unknown, ...values: unknown[]) {
              beforeDelivery?.();
              counts.callbacks++;
              nativeCallbackDepth++;
              try {
                return Reflect.apply(listener, this, values);
              } finally {
                nativeCallbackDepth--;
              }
            },
          };
          entries.set(listener, entry);
        }
        const cleanup: unknown = Reflect.apply(original, this, [entry.callback, ...args.slice(1)]);
        if (typeof cleanup !== "function") {
          throw new Error(`Native subscribe returned no cleanup: ${label}`);
        }
        counts.subscribeCalls++;
        if (!entry.active) {
          entry.active = true;
          counts.active++;
          counts.peak = Math.max(counts.peak, counts.active);
        }
        const registered = entry;
        return function (this: unknown, ...values: unknown[]) {
          const result: unknown = Reflect.apply(cleanup, this, values);
          counts.cleanupCalls++;
          if (registered.active) {
            registered.active = false;
            counts.active--;
          }
          return result;
        };
      },
    });
    restore.push(() => {
      if (descriptor) {
        Object.defineProperty(source, method, descriptor);
      } else {
        Reflect.deleteProperty(source, method);
      }
    });
  }

  return {
    observeSource,
    observeWidgets,
    observeMethod,
    methodSnapshot: () => structuredClone(methods),
    snapshot: (): ProjectionResourceSnapshot => structuredClone({ sources, scans }),
    dispose() {
      for (const undo of restore.toReversed()) {
        undo();
      }
      restore.length = 0;
    },
  };
}

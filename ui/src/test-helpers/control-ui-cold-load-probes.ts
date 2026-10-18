/** Serialized after the mock Gateway, before application modules execute. */
export function installColdLoadProbes(input: {
  latencyMs: number;
  frameGapMs: number;
  events: Array<{ event: string; payload: unknown }>;
}) {
  const updates = new Map<string, { count: number; ms: number }>();
  const rpcs: Array<{ method: string; requestBytes: number; responseBytes: number; ms: number }> =
    [];
  const pending = new Map<string, { method: string; bytes: number; at: number }>();
  let lastActivity = performance.now();
  let queued = 0;
  let sentEvents = 0;
  let nextFrameAt = 0;
  let progressId: string | undefined;
  let instanceId: string | undefined;
  let eventsStarted = false;
  const patched = new WeakSet<object>();
  const define = customElements.define.bind(customElements);
  customElements.define = (name, constructor, options) => {
    let prototype = constructor.prototype;
    while (prototype && !Object.hasOwn(prototype, "performUpdate")) {
      prototype = Object.getPrototypeOf(prototype);
    }
    if (prototype && !patched.has(prototype)) {
      patched.add(prototype);
      const performUpdate = prototype.performUpdate;
      prototype.performUpdate = function (...args: unknown[]) {
        const stats = updates.get(this.localName) ?? { count: 0, ms: 0 };
        const started = performance.now();
        try {
          return performUpdate.apply(this, args);
        } finally {
          stats.count++;
          stats.ms += performance.now() - started;
          updates.set(this.localName, stats);
          lastActivity = performance.now();
        }
      };
    }
    define(name, constructor, options);
  };
  const Original = window.WebSocket;
  window.WebSocket = new Proxy(Original, {
    construct(target, args) {
      // The mock constructor returns its routed socket rather than its own instance.
      const socket: WebSocket = Reflect.construct(target, args);
      const send = socket.send.bind(socket);
      const dispatch = socket.dispatchEvent.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          const frame = JSON.parse(data);
          if (frame.type === "req") {
            pending.set(frame.id, {
              method: frame.method,
              bytes: new TextEncoder().encode(data).length,
              at: performance.now(),
            });
            if (frame.method === "connect") {
              instanceId = frame.params?.client?.instanceId;
            }
            if (frame.method === "sessions.catalog.list") {
              progressId = frame.params?.progressId;
              if (!eventsStarted) {
                eventsStarted = true;
                input.events.forEach((item, index) => {
                  queued++;
                  window.setTimeout(
                    () => {
                      queued--;
                      const payload = JSON.parse(JSON.stringify(item.payload), (key, value) =>
                        key === "progressId"
                          ? progressId
                          : key === "instanceId" && value === "team-scale-self"
                            ? instanceId
                            : value,
                      );
                      Reflect.get(window, "openclawControlUiE2eGateway").emit(item.event, payload);
                      sentEvents++;
                    },
                    input.latencyMs + (index + 1) * input.frameGapMs,
                  );
                });
              }
            }
          }
        }
        send(data);
      };
      socket.dispatchEvent = (event) => {
        if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
          return dispatch(event);
        }
        const frame = JSON.parse(event.data);
        // A single wire delivers one message task at a time, including concurrent RPC replies.
        nextFrameAt = Math.max(performance.now() + input.latencyMs, nextFrameAt + input.frameGapMs);
        queued++;
        window.setTimeout(
          () => {
            queued--;
            const request = pending.get(frame.id);
            if (request) {
              pending.delete(frame.id);
              rpcs.push({
                method: request.method,
                requestBytes: request.bytes,
                responseBytes: new TextEncoder().encode(event.data).length,
                ms: performance.now() - request.at,
              });
            }
            dispatch(event);
            lastActivity = performance.now();
          },
          Math.max(0, nextFrameAt - performance.now()),
        );
        return true;
      };
      return socket;
    },
  });
  const longTasks: Array<{ start: number; duration: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTasks.push({ start: entry.startTime, duration: entry.duration });
    }
  });
  observer.observe({ type: "longtask", buffered: true });
  Reflect.set(window, "__coldLoad", {
    read() {
      return {
        at: performance.now(),
        pending: pending.size,
        pendingMethods: [...pending.values()].map((request) => request.method),
        queued,
        sentEvents,
        idleMs: performance.now() - lastActivity,
        updates: Object.fromEntries(updates),
        rpcs,
        longTasks,
      };
    },
  });
}

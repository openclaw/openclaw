/** Serialized after the mock Gateway, before application modules execute. */
export function installColdLoadProbes(input: {
  latencyMs: number;
  frameGapMs: number;
  events: Array<{ event: string; payload: unknown }>;
  liveEvents?: Array<{ atMs: number; kind: string; event: string; payload: unknown }>;
}) {
  Reflect.set(Error, "stackTraceLimit", 40);
  const updates = new Map<string, { count: number; ms: number }>();
  const rpcs: Array<{
    method: string;
    requestBytes: number;
    responseBytes: number;
    ms: number;
    params: unknown;
    stack: string | undefined;
  }> = [];
  const pending = new Map<
    string,
    { method: string; bytes: number; at: number; params: unknown; stack: string | undefined }
  >();
  let lastActivity = performance.now();
  let queued = 0;
  let sentEvents = 0;
  let nextFrameAt = 0;
  let progressId: string | undefined;
  let instanceId: string | undefined;
  let eventsStarted = false;
  const liveUpdates = new Map<string, Map<string, { count: number; ms: number }>>();
  const liveStacks = new Map<string, number>();
  const liveOrigins = new Map<string, number>();
  let liveInvalidatorOwner:
    | { requestSessionDataUpdate: (...args: unknown[]) => unknown }
    | undefined;
  let originalLiveInvalidator: ((...args: unknown[]) => unknown) | undefined;
  type SessionDataProbeOwner = {
    requestSessionDataUpdate: (...args: unknown[]) => unknown;
  };
  type SolidSidebarProbeOwner = {
    readonly hostElement: HTMLElement;
    readonly isConnected: boolean;
    sessionData: SessionDataProbeOwner;
    requestUpdate(): void;
    prepareRender(): void;
    commitRender(): void;
  };
  type SidebarLifecycle = "requestUpdate" | "prepareRender" | "commitRender";
  let solidSidebarOwner: SolidSidebarProbeOwner | undefined;
  const sidebarLifecycleOriginals = new Map<SidebarLifecycle, () => void>();
  const sidebarLifecycle = new Map<string, Map<SidebarLifecycle, { count: number; ms: number }>>();
  const sidebarOwnerStacks = new Map<string, number>();
  const sidebarRegistration = {
    originalSet: WeakMap.prototype.set,
    matches(host: unknown, owner: unknown): owner is SolidSidebarProbeOwner {
      return (
        host instanceof HTMLElement &&
        host.localName === "openclaw-app-sidebar" &&
        typeof owner === "object" &&
        owner !== null &&
        "hostElement" in owner &&
        owner.hostElement === host &&
        "isConnected" in owner &&
        typeof owner.isConnected === "boolean" &&
        "requestUpdate" in owner &&
        typeof owner.requestUpdate === "function" &&
        "prepareRender" in owner &&
        typeof owner.prepareRender === "function" &&
        "commitRender" in owner &&
        typeof owner.commitRender === "function" &&
        "sessionData" in owner &&
        typeof owner.sessionData === "object" &&
        owner.sessionData !== null &&
        "requestSessionDataUpdate" in owner.sessionData &&
        typeof owner.sessionData.requestSessionDataUpdate === "function"
      );
    },
    set(this: WeakMap<WeakKey, unknown>, host: WeakKey, owner: unknown) {
      const result: WeakMap<WeakKey, unknown> = Reflect.apply(
        sidebarRegistration.originalSet,
        this,
        [host, owner],
      );
      if (sidebarRegistration.matches(host, owner)) {
        solidSidebarOwner = owner;
        sidebarRegistration.restore();
      }
      return result;
    },
    restore() {
      if (WeakMap.prototype.set === sidebarRegistration.set) {
        WeakMap.prototype.set = sidebarRegistration.originalSet;
      }
    },
  };
  // Tap the existing host→owner registration without exposing a production debug API.
  WeakMap.prototype.set = sidebarRegistration.set;
  window.addEventListener("pagehide", () => sidebarRegistration.restore(), { once: true });
  const liveEvents = new Map<string, number>();
  const liveWatch = new Set([
    "openclaw-app-sidebar",
    "openclaw-sidebar-agent-card",
    "openclaw-sidebar-attention",
    "openclaw-chat-page",
    "openclaw-chat-pane",
    "openclaw-app-shell",
  ]);
  let liveStartedAt = 0;
  let liveFinishedAt = 0;
  let liveKind = "idle";
  let emittingLiveKind: string | undefined;
  const patchedRequests = new WeakSet<object>();
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
          if (liveStartedAt) {
            const group = liveUpdates.get(liveKind) ?? new Map();
            const live = group.get(this.localName) ?? { count: 0, ms: 0 };
            live.count++;
            live.ms += performance.now() - started;
            group.set(this.localName, live);
            liveUpdates.set(liveKind, group);
          }
          stats.count++;
          stats.ms += performance.now() - started;
          updates.set(this.localName, stats);
          lastActivity = performance.now();
        }
      };
    }
    prototype = constructor.prototype;
    while (prototype && !Object.hasOwn(prototype, "requestUpdate")) {
      prototype = Object.getPrototypeOf(prototype);
    }
    if (prototype && !patchedRequests.has(prototype)) {
      patchedRequests.add(prototype);
      const requestUpdate = prototype.requestUpdate;
      prototype.requestUpdate = function (property: PropertyKey | undefined, ...args: unknown[]) {
        const wasPending = this.isUpdatePending;
        const result = requestUpdate.apply(this, [property, ...args]);
        if (
          liveStartedAt &&
          liveWatch.has(this.localName) &&
          this.hasUpdated &&
          !wasPending &&
          this.isUpdatePending
        ) {
          const stack = new Error().stack?.split("\n").slice(2, 14).join(" <- ") ?? "";
          const key = `${liveKind} :: ${this.localName} :: ${String(property ?? "-")} :: ${stack}`;
          if (liveStacks.has(key) || liveStacks.size < 500) {
            liveStacks.set(key, (liveStacks.get(key) ?? 0) + 1);
          }
        }
        return result;
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
              params: frame.params,
              stack: new Error().stack,
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
        const deliveredKind = emittingLiveKind;
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
                params: request.params,
                stack: request.stack,
                requestBytes: request.bytes,
                responseBytes: new TextEncoder().encode(event.data).length,
                ms: performance.now() - request.at,
              });
            }
            if (deliveredKind) {
              liveKind = deliveredKind;
              liveEvents.set(deliveredKind, (liveEvents.get(deliveredKind) ?? 0) + 1);
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
    startLive() {
      liveStartedAt = performance.now();
      const sidebar = document.querySelector("openclaw-app-sidebar");
      sidebarRegistration.restore();
      if (
        sidebar &&
        !solidSidebarOwner &&
        typeof Reflect.get(sidebar, "performUpdate") !== "function"
      ) {
        throw new Error("Solid sidebar owner registration was not captured");
      }
      if (solidSidebarOwner) {
        const owner = solidSidebarOwner;
        for (const method of ["requestUpdate", "prepareRender", "commitRender"] as const) {
          const original = owner[method];
          sidebarLifecycleOriginals.set(method, original);
          owner[method] = function () {
            const started = performance.now();
            const connected = this.isConnected;
            if (method === "requestUpdate" && connected) {
              const stack = new Error().stack?.split("\n").slice(2, 14).join(" <- ") ?? "";
              const key = `${liveKind} :: ${stack}`;
              if (sidebarOwnerStacks.has(key) || sidebarOwnerStacks.size < 100) {
                sidebarOwnerStacks.set(key, (sidebarOwnerStacks.get(key) ?? 0) + 1);
              }
            }
            try {
              return original.call(this);
            } finally {
              if (connected) {
                const group = sidebarLifecycle.get(liveKind) ?? new Map();
                const stats = group.get(method) ?? { count: 0, ms: 0 };
                stats.count++;
                stats.ms += performance.now() - started;
                group.set(method, stats);
                sidebarLifecycle.set(liveKind, group);
                lastActivity = performance.now();
              }
            }
          };
        }
      }
      const owner: SessionDataProbeOwner | undefined =
        solidSidebarOwner?.sessionData ??
        (sidebar ? Reflect.get(sidebar, "sessionData") : undefined);
      if (owner) {
        const original = owner.requestSessionDataUpdate;
        owner.requestSessionDataUpdate = function (...args: unknown[]) {
          const stack = new Error().stack?.split("\n").slice(2, 14).join(" <- ") ?? "";
          const key = `${liveKind} :: ${stack}`;
          if (liveOrigins.has(key) || liveOrigins.size < 100) {
            liveOrigins.set(key, (liveOrigins.get(key) ?? 0) + 1);
          }
          return original.apply(this, args);
        };
        liveInvalidatorOwner = owner;
        originalLiveInvalidator = original;
      }
      for (const item of input.liveEvents ?? []) {
        window.setTimeout(() => {
          emittingLiveKind = item.kind;
          const payload = JSON.parse(JSON.stringify(item.payload), (key, value) =>
            key === "progressId"
              ? progressId
              : key === "instanceId" && value === "team-scale-self"
                ? instanceId
                : value,
          );
          Reflect.get(window, "openclawControlUiE2eGateway").emit(item.event, payload);
          emittingLiveKind = undefined;
        }, item.atMs);
      }
    },
    finishLive() {
      liveFinishedAt = performance.now();
      sidebarRegistration.restore();
      if (solidSidebarOwner) {
        for (const [method, original] of sidebarLifecycleOriginals) {
          solidSidebarOwner[method] = original;
        }
        sidebarLifecycleOriginals.clear();
      }
      if (liveInvalidatorOwner && originalLiveInvalidator) {
        liveInvalidatorOwner.requestSessionDataUpdate = originalLiveInvalidator;
      }
    },
    readLive() {
      return {
        elapsedMs: (liveFinishedAt || performance.now()) - liveStartedAt,
        sentEvents: [...liveEvents.values()].reduce((sum, count) => sum + count, 0),
        events: Object.fromEntries(liveEvents),
        updates: Object.fromEntries(
          [...liveUpdates].map(([kind, tags]) => [kind, Object.fromEntries(tags)]),
        ),
        stacks: Object.fromEntries(liveStacks),
        sidebarInvalidations: Object.fromEntries(liveOrigins),
        solidSidebar: solidSidebarOwner
          ? {
              measurement: "owner-invalidations-and-projection-lifecycle-passes",
              lifecycle: Object.fromEntries(
                [...sidebarLifecycle].map(([kind, methods]) => [kind, Object.fromEntries(methods)]),
              ),
              invalidationStacks: Object.fromEntries(sidebarOwnerStacks),
            }
          : null,
      };
    },
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

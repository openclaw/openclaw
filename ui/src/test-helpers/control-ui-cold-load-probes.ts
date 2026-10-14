/** Serialized after the mock Gateway, before application modules execute. */
export function installColdLoadProbes(input: {
  latencyMs: number;
  frameGapMs: number;
  events: Array<{ event: string; payload: unknown }>;
  liveEvents?: Array<{
    atMs: number;
    kind: string;
    event: string;
    payload: unknown;
    history?: { text?: string; message?: unknown };
  }>;
  liveHistory?: {
    sessionId: string;
    sessionInfo: unknown;
    messages: unknown[];
    inFlightRun: { runId: string; text: string; startedAt: number; events: unknown[] };
  };
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
  type ProbeMethod = (...args: unknown[]) => unknown;
  type ChatMethod =
    | "requestUpdate"
    | "performUpdate"
    | "render"
    | "prepareRender"
    | "commitRender"
    | "afterCommit";
  type ChatProbeOwner = {
    readonly isConnected: boolean;
    requestUpdate: ProbeMethod;
    performUpdate: ProbeMethod;
    render: ProbeMethod;
    prepareRender?: ProbeMethod;
    commitRender?: ProbeMethod;
    afterCommit?: ProbeMethod;
  };
  type ChatOwnerRecord = {
    host: HTMLElement;
    owner: ChatProbeOwner;
    originals: Map<ChatMethod, ProbeMethod>;
    pending: Map<string, number>;
    pendingRequests: Map<number, string>;
    queuedRequests: Map<number, string>;
    publicationRequests: Map<number, string>;
    publicationPending: boolean;
  };
  const chatOwners = new Map<HTMLElement, ChatOwnerRecord>();
  const chatLifecycle = new Map<string, Map<string, Map<string, { count: number; ms: number }>>>();
  const chatProducerStacks = new Map<string, number>();
  type LiveDeliveryOrigin = {
    index: number;
    kind: string;
    event: string;
    plannedAtMs: number;
    queuedAtMs: number;
    deliveredAtMs: number;
  };
  type FrameOrigin = {
    id: number;
    frameId: number;
    scheduledAtMs: number;
    schedulingStack: string;
    delivery: LiveDeliveryOrigin | null;
    parentId: number | null;
  };
  let activeLiveDelivery: LiveDeliveryOrigin | null = null;
  let activeFrameOrigin: FrameOrigin | null = null;
  const frameOrigins = new Map<number, FrameOrigin>();
  const frameProbe = {
    original: window.requestAnimationFrame,
    request(this: Window, callback: FrameRequestCallback): number {
      if (frameOrigins.size >= 5000) {
        throw new Error("Live frame scheduling origin limit exceeded");
      }
      const origin: FrameOrigin = {
        id: frameOrigins.size + 1,
        frameId: 0,
        scheduledAtMs: performance.now() - liveStartedAt,
        schedulingStack: new Error().stack?.split("\n").slice(2, 18).join(" <- ") ?? "",
        delivery: activeLiveDelivery,
        parentId: activeFrameOrigin?.id ?? null,
      };
      origin.frameId = frameProbe.original.call(this, function (this: unknown, timestamp: number) {
        const previous = activeFrameOrigin;
        activeFrameOrigin = liveStartedAt && !liveFinishedAt ? origin : null;
        try {
          callback.call(this, timestamp);
        } finally {
          activeFrameOrigin = previous;
        }
      });
      frameOrigins.set(origin.id, origin);
      return origin.frameId;
    },
    install() {
      // oxlint-disable-next-line typescript/unbound-method -- Installed as a window method; forwards that receiver to the native frame owner.
      window.requestAnimationFrame = frameProbe.request;
    },
    restore() {
      if (window.requestAnimationFrame === frameProbe.request) {
        window.requestAnimationFrame = frameProbe.original;
      }
    },
  };
  const chatRequests = new Map<
    number,
    { tag: string; producer: string; frameOriginId: number | null }
  >();
  let previousChatHook: unknown;
  let previousChatHookDescriptor: PropertyDescriptor | undefined;
  const chatPasses: Array<{
    tag: string;
    kind: string;
    atMs: number;
    producers: Record<string, number>;
    requestIds: number[];
    requestAttributed: boolean;
    unattributed: boolean;
    entryStack: string;
  }> = [];
  const chatProbe = {
    installed: false,
    matches(host: unknown, owner: unknown): owner is ChatProbeOwner {
      return (
        host instanceof HTMLElement &&
        typeof owner === "object" &&
        owner !== null &&
        "isConnected" in owner &&
        typeof owner.isConnected === "boolean" &&
        "requestUpdate" in owner &&
        typeof owner.requestUpdate === "function" &&
        "performUpdate" in owner &&
        typeof owner.performUpdate === "function" &&
        "render" in owner &&
        typeof owner.render === "function" &&
        ((host.localName === "openclaw-chat-page" &&
          "host" in owner &&
          owner.host === host &&
          "afterCommit" in owner &&
          typeof owner.afterCommit === "function") ||
          (host.localName === "openclaw-chat-pane" &&
            "element" in owner &&
            owner.element === host &&
            "prepareRender" in owner &&
            typeof owner.prepareRender === "function" &&
            "commitRender" in owner &&
            typeof owner.commitRender === "function"))
      );
    },
    record(tag: string, method: string, ms = 0) {
      const kinds = chatLifecycle.get(tag) ?? new Map();
      const methods = kinds.get(liveKind) ?? new Map();
      const stats = methods.get(method) ?? { count: 0, ms: 0 };
      stats.count++;
      stats.ms += ms;
      methods.set(method, stats);
      kinds.set(liveKind, methods);
      chatLifecycle.set(tag, kinds);
      lastActivity = performance.now();
    },
    producer(record: ChatOwnerRecord, source: string) {
      const stack = new Error().stack?.split("\n").slice(3, 18).join(" <- ") ?? "";
      const key = `${liveKind} :: ${record.host.localName} :: ${source} :: ${stack}`;
      if (!chatProducerStacks.has(key) && chatProducerStacks.size >= 1000) {
        throw new Error("Live chat producer stack limit exceeded");
      }
      chatProducerStacks.set(key, (chatProducerStacks.get(key) ?? 0) + 1);
      record.pending.set(key, (record.pending.get(key) ?? 0) + 1);
      if (source.startsWith("requestUpdate:")) {
        if (chatRequests.size >= 5000) {
          throw new Error("Live chat owner request limit exceeded");
        }
        const id = chatRequests.size + 1;
        chatRequests.set(id, {
          tag: record.host.localName,
          producer: key,
          // Null includes callbacks queued before live instrumentation; never infer their caller.
          frameOriginId: activeFrameOrigin?.id ?? null,
        });
        record.pendingRequests.set(id, key);
        record.queuedRequests.set(id, key);
      }
    },
    hook(this: void, host: object, phase: "invalidate" | "commit") {
      if (liveStartedAt && !liveFinishedAt) {
        for (const record of chatOwners.values()) {
          if ((host === record.host || host === record.owner) && record.owner.isConnected) {
            const target = host === record.host ? "element" : "owner";
            chatProbe.record(record.host.localName, `lifecycle.${phase}.${target}`);
            if (phase === "invalidate") {
              chatProbe.producer(record, `lifecycle.invalidate.${target}`);
            }
          }
        }
      }
      if (typeof previousChatHook === "function") {
        Reflect.apply(previousChatHook, globalThis, [host, phase]);
      }
    },
    install() {
      for (const tag of ["openclaw-chat-page", "openclaw-chat-pane"]) {
        for (const host of document.querySelectorAll(tag)) {
          if (!(host instanceof HTMLElement)) {
            continue;
          }
          if (!chatOwners.has(host) && typeof Reflect.get(host, "performUpdate") !== "function") {
            throw new Error(`Solid ${tag} owner registration was not captured`);
          }
        }
      }
      for (const record of chatOwners.values()) {
        const owner = record.owner;
        for (const method of [
          "requestUpdate",
          "performUpdate",
          "render",
          "prepareRender",
          "commitRender",
          "afterCommit",
        ] as const) {
          const original = owner[method];
          if (!original) {
            continue;
          }
          record.originals.set(method, original);
          owner[method] = function (this: ChatProbeOwner, ...args: unknown[]) {
            const connected = this.isConnected;
            if (connected && method === "requestUpdate") {
              const property = args[0];
              const propertyLabel =
                typeof property === "string" ||
                typeof property === "number" ||
                typeof property === "symbol"
                  ? String(property)
                  : "-";
              chatProbe.producer(record, `requestUpdate:${propertyLabel}`);
            }
            if (connected && method === "performUpdate") {
              record.publicationRequests = new Map(record.queuedRequests);
              record.queuedRequests.clear();
              record.publicationPending = true;
            }
            if (connected && method === "render") {
              if (chatPasses.length >= 5000) {
                throw new Error("Live chat projection pass limit exceeded");
              }
              const requests = record.publicationPending
                ? new Map(record.publicationRequests)
                : new Map<number, string>();
              const producers = new Map(record.pending);
              for (const [id, producer] of requests) {
                if (!record.pendingRequests.has(id)) {
                  producers.set(producer, (producers.get(producer) ?? 0) + 1);
                }
              }
              for (const [id, producer] of record.pendingRequests) {
                requests.set(id, producer);
              }
              chatPasses.push({
                tag: record.host.localName,
                kind: liveKind,
                atMs: performance.now() - liveStartedAt,
                producers: Object.fromEntries(producers),
                requestIds: [...requests.keys()].toSorted((left, right) => left - right),
                requestAttributed: requests.size > 0,
                unattributed: producers.size === 0,
                entryStack: new Error().stack?.split("\n").slice(2, 18).join(" <- ") ?? "",
              });
              record.pending.clear();
              record.pendingRequests.clear();
              record.publicationPending = false;
            }
            const started = performance.now();
            try {
              return original.apply(this, args);
            } finally {
              if (connected) {
                chatProbe.record(record.host.localName, method, performance.now() - started);
              }
            }
          };
        }
      }
      previousChatHookDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "openclawRenderLifecycleTestHook",
      );
      previousChatHook = Reflect.get(globalThis, "openclawRenderLifecycleTestHook");
      // The existing pane adapter exposes an accessor; preserve its callback while tapping it.
      Object.defineProperty(globalThis, "openclawRenderLifecycleTestHook", {
        configurable: true,
        writable: true,
        value: chatProbe.hook,
      });
      chatProbe.installed = true;
    },
    restore() {
      for (const record of chatOwners.values()) {
        for (const [method, original] of record.originals) {
          record.owner[method] = original;
        }
        record.originals.clear();
      }
      if (
        chatProbe.installed &&
        Reflect.get(globalThis, "openclawRenderLifecycleTestHook") === chatProbe.hook
      ) {
        if (previousChatHookDescriptor === undefined) {
          Reflect.deleteProperty(globalThis, "openclawRenderLifecycleTestHook");
        } else {
          Object.defineProperty(
            globalThis,
            "openclawRenderLifecycleTestHook",
            previousChatHookDescriptor,
          );
        }
      }
      chatProbe.installed = false;
    },
    read() {
      return {
        measurement: "owner-requests-publications-projection-passes-and-commits",
        lifecycle: Object.fromEntries(
          [...chatLifecycle].map(([tag, kinds]) => [
            tag,
            Object.fromEntries(
              [...kinds].map(([kind, methods]) => [kind, Object.fromEntries(methods)]),
            ),
          ]),
        ),
        producerStacks: Object.fromEntries(chatProducerStacks),
        requests: Object.fromEntries(chatRequests),
        frameOrigins: Object.fromEntries(frameOrigins),
        frameOriginCoverage: "captured-live-schedules-only; pre-live-frames-have-null-origin",
        passes: chatPasses,
        pendingProducers: [...chatOwners.values()].map((record) => ({
          tag: record.host.localName,
          producers: Object.fromEntries(record.pending),
        })),
      };
    },
  };
  let solidSidebarOwner: SolidSidebarProbeOwner | undefined;
  const sidebarLifecycleOriginals = new Map<SidebarLifecycle, () => void>();
  const sidebarLifecycle = new Map<string, Map<SidebarLifecycle, { count: number; ms: number }>>();
  const sidebarOwnerStacks = new Map<string, number>();
  const sidebarRegistration = {
    // oxlint-disable-next-line typescript/unbound-method -- Save the native method for restoration; Reflect.apply forwards each WeakMap receiver.
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
      }
      if (host instanceof HTMLElement && chatProbe.matches(host, owner)) {
        chatOwners.set(host, {
          host,
          owner,
          originals: new Map(),
          pending: new Map(),
          pendingRequests: new Map(),
          queuedRequests: new Map(),
          publicationRequests: new Map(),
          publicationPending: false,
        });
      }
      if (
        solidSidebarOwner &&
        [...chatOwners.keys()].some((chatHost) => chatHost.localName === "openclaw-chat-page") &&
        [...chatOwners.keys()].some((chatHost) => chatHost.localName === "openclaw-chat-pane")
      ) {
        sidebarRegistration.restore();
      }
      return result;
    },
    restore() {
      if (WeakMap.prototype.set === sidebarRegistration.set) {
        // oxlint-disable-next-line no-extend-native -- Restore the native setter immediately after this benchmark-only registration tap.
        WeakMap.prototype.set = sidebarRegistration.originalSet;
      }
    },
  };
  // Tap the existing host→owner registration without exposing a production debug API.
  // oxlint-disable-next-line no-extend-native, typescript/unbound-method -- This temporary benchmark tap forwards the WeakMap receiver and restores the native setter after capture or teardown.
  WeakMap.prototype.set = sidebarRegistration.set;
  window.addEventListener(
    "pagehide",
    () => {
      sidebarRegistration.restore();
      chatProbe.restore();
      frameProbe.restore();
    },
    { once: true },
  );
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
  let emittingLiveEvent:
    | { index: number; kind: string; event: string; plannedAtMs: number; queuedAtMs: number }
    | undefined;
  const liveDeliveries: Array<{
    index: number;
    kind: string;
    event: string;
    plannedAtMs: number;
    queuedAtMs: number;
    deliveredAtMs: number;
    gapMs: number | null;
  }> = [];
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
        const liveEvent = emittingLiveEvent;
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
            const delivery = liveEvent
              ? { ...liveEvent, deliveredAtMs: performance.now() - liveStartedAt }
              : null;
            if (delivery) {
              const previous = liveDeliveries.at(-1);
              liveDeliveries.push({
                ...delivery,
                gapMs: previous ? delivery.deliveredAtMs - previous.deliveredAtMs : null,
              });
              liveKind = delivery.kind;
              liveEvents.set(delivery.kind, (liveEvents.get(delivery.kind) ?? 0) + 1);
            }
            const previousDelivery = activeLiveDelivery;
            activeLiveDelivery = delivery;
            try {
              dispatch(event);
            } finally {
              activeLiveDelivery = previousDelivery;
            }
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
      frameProbe.install();
      const sidebar = document.querySelector("openclaw-app-sidebar");
      sidebarRegistration.restore();
      chatProbe.install();
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
          owner[method] = function (this: SolidSidebarProbeOwner) {
            const connected = this.isConnected;
            if (method === "requestUpdate" && connected) {
              const stack = new Error().stack?.split("\n").slice(2, 14).join(" <- ") ?? "";
              const key = `${liveKind} :: ${stack}`;
              if (sidebarOwnerStacks.has(key) || sidebarOwnerStacks.size < 100) {
                sidebarOwnerStacks.set(key, (sidebarOwnerStacks.get(key) ?? 0) + 1);
              }
            }
            const started = performance.now();
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
      const history = input.liveHistory;
      const gateway = Reflect.get(window, "openclawControlUiE2eGateway");
      if (history) {
        gateway.setRequestHandler("chat.history", () => ({
          ...history,
          messages: [...history.messages],
          inFlightRun: { ...history.inFlightRun },
        }));
      }
      for (const [index, item] of (input.liveEvents ?? []).entries()) {
        window.setTimeout(() => {
          emittingLiveEvent = {
            index: index + 1,
            kind: item.kind,
            event: item.event,
            plannedAtMs: item.atMs,
            queuedAtMs: performance.now() - liveStartedAt,
          };
          const payload = JSON.parse(JSON.stringify(item.payload), (key, value) =>
            key === "progressId"
              ? progressId
              : key === "instanceId" && value === "team-scale-self"
                ? instanceId
                : value,
          );
          if (history && item.history) {
            if (item.history.message !== undefined) {
              history.messages.push(item.history.message);
            }
            if (item.history.text !== undefined) {
              history.inFlightRun.text = item.history.text;
            }
          }
          gateway.emit(item.event, payload);
          emittingLiveEvent = undefined;
        }, item.atMs);
      }
    },
    finishLive() {
      liveFinishedAt = performance.now();
      frameProbe.restore();
      sidebarRegistration.restore();
      chatProbe.restore();
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
        deliveryCadence: {
          events: liveDeliveries,
          adjacentGapThresholdMs: 16,
          shortAdjacentGaps: liveDeliveries.filter(
            (delivery) => delivery.gapMs !== null && delivery.gapMs < 16,
          ).length,
          maxLatenessMs: Math.max(
            0,
            ...liveDeliveries.map((delivery) => delivery.deliveredAtMs - delivery.plannedAtMs),
          ),
        },
        updates: Object.fromEntries(
          [...liveUpdates].map(([kind, tags]) => [kind, Object.fromEntries(tags)]),
        ),
        stacks: Object.fromEntries(liveStacks),
        sidebarInvalidations: Object.fromEntries(liveOrigins),
        solidChat: chatProbe.read(),
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

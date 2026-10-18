import { createColdLoadEventStream } from "./control-ui-cold-load-event-stream.ts";
import { createColdLoadFrameProbe } from "./control-ui-cold-load-probe-init.ts";
import type * as ProbeInit from "./control-ui-cold-load-probe-init.ts";

export function createColdLoadProbeInitScript(input: ProbeInit.ColdLoadProbeInput): string {
  // Serialized closures share the Node transform's function-name helper.
  return `;(() => { const __name = (target) => target; (${installColdLoadProbes.toString()})(${JSON.stringify(input)}, ${createColdLoadFrameProbe.toString()}, ${createColdLoadEventStream.toString()}); })();`;
}

/** Serialized after the mock Gateway, before application modules execute. */
function installColdLoadProbes(
  input: ProbeInit.ColdLoadProbeInput,
  createFrameProbe: typeof ProbeInit.createColdLoadFrameProbe,
  createEventStream: typeof createColdLoadEventStream,
) {
  Reflect.set(Error, "stackTraceLimit", 40);
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  function matchesOwner(
    host: unknown,
    owner: unknown,
    tag: string,
    elementKey: string,
  ): owner is Record<string, unknown> {
    return (
      host instanceof HTMLElement &&
      host.localName === tag &&
      isRecord(owner) &&
      owner[elementKey] === host &&
      typeof owner.isConnected === "boolean"
    );
  }
  const rpcs: Array<{
    method: string;
    requestBytes: number;
    responseBytes: number;
    ms: number;
    dispatchMs?: number;
    responseAtMs?: number;
    params: unknown;
    stack: string | undefined;
  }> = [];
  const pending = new Map<
    string,
    { method: string; bytes: number; at: number; params: unknown; stack: string | undefined }
  >();
  let lastActivity = performance.now();
  let queued = 0;
  let nextFrameAt = 0;
  const eventStream = createEventStream(input);
  const liveOrigins = new Map<string, number>();
  let liveInvalidatorOwner: ProbeInit.SessionDataProbeOwner | undefined;
  let originalLiveInvalidator: ProbeInit.ProbeMethod | undefined;
  const chatOwners = new Map<HTMLElement, ProbeInit.ChatOwnerRecord>();
  function lifecycleCounter() {
    const groups = new Map<string, Map<string, { count: number; ms: number }>>();
    return {
      record(method: string, ms: number) {
        const methods = groups.get(liveKind) ?? new Map();
        const stats = methods.get(method) ?? { count: 0, ms: 0 };
        stats.count++;
        stats.ms += ms;
        methods.set(method, stats);
        groups.set(liveKind, methods);
        lastActivity = performance.now();
      },
      read: () =>
        Object.fromEntries(
          [...groups].map(([kind, methods]) => [kind, Object.fromEntries(methods)]),
        ),
    };
  }
  const chatLifecycle = new Map<string, ReturnType<typeof lifecycleCounter>>();
  const chatProducerStacks = new Map<string, number>();
  const frameProbe = createFrameProbe(() => ({
    startedAt: liveStartedAt,
    finishedAt: liveFinishedAt,
  }));
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
    matches(host: unknown, owner: unknown): owner is ProbeInit.ChatProbeOwner {
      return (
        matchesOwner(host, owner, "openclaw-chat-pane", "element") &&
        typeof owner.render === "function"
      );
    },
    record(tag: string, method: string, ms = 0) {
      const counter = chatLifecycle.get(tag) ?? lifecycleCounter();
      counter.record(method, ms);
      chatLifecycle.set(tag, counter);
    },
    producer(record: ProbeInit.ChatOwnerRecord, source: string) {
      const stack = new Error().stack?.split("\n").slice(3, 18).join(" <- ") ?? "";
      const key = `${liveKind} :: ${record.host.localName} :: ${source} :: ${stack}`;
      if (!chatProducerStacks.has(key) && chatProducerStacks.size >= 1000) {
        throw new Error("Live chat producer stack limit exceeded");
      }
      chatProducerStacks.set(key, (chatProducerStacks.get(key) ?? 0) + 1);
      record.pending.set(key, (record.pending.get(key) ?? 0) + 1);
      if (chatRequests.size >= 5000) {
        throw new Error("Live chat lifecycle request limit exceeded");
      }
      const id = chatRequests.size + 1;
      chatRequests.set(id, {
        tag: record.host.localName,
        producer: key,
        // Null includes callbacks queued before live instrumentation; never infer their caller.
        frameOriginId: frameProbe.currentOriginId(),
      });
      record.pendingRequests.set(id, key);
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
      for (const host of document.querySelectorAll("openclaw-chat-pane")) {
        if (host instanceof HTMLElement && !chatOwners.has(host)) {
          throw new Error("Solid openclaw-chat-pane owner registration was not captured");
        }
      }
      for (const record of chatOwners.values()) {
        const original = record.owner.render;
        record.originalRender = original;
        record.owner.render = function (this: ProbeInit.ChatProbeOwner, ...args: unknown[]) {
          const connected = this.isConnected;
          if (connected) {
            if (chatPasses.length >= 5000) {
              throw new Error("Live chat projection pass limit exceeded");
            }
            chatPasses.push({
              tag: record.host.localName,
              kind: liveKind,
              atMs: performance.now() - liveStartedAt,
              producers: Object.fromEntries(record.pending),
              requestIds: [...record.pendingRequests.keys()].toSorted(
                (left, right) => left - right,
              ),
              requestAttributed: record.pendingRequests.size > 0,
              unattributed: record.pending.size === 0,
              entryStack: new Error().stack?.split("\n").slice(2, 18).join(" <- ") ?? "",
            });
            record.pending.clear();
            record.pendingRequests.clear();
          }
          const started = performance.now();
          try {
            return original.apply(this, args);
          } finally {
            if (connected) {
              chatProbe.record(record.host.localName, "render", performance.now() - started);
            }
          }
        };
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
        if (record.originalRender) {
          record.owner.render = record.originalRender;
          record.originalRender = undefined;
        }
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
        measurement: "pane-render-passes-and-explicit-lifecycle-notifications",
        unmeasured: ["page snapshot computations", "fine-grained Solid bindings"],
        lifecycle: Object.fromEntries(
          [...chatLifecycle].map(([tag, counter]) => [tag, counter.read()]),
        ),
        producerStacks: Object.fromEntries(chatProducerStacks),
        requests: Object.fromEntries(chatRequests),
        ...frameProbe.read(),
        passes: chatPasses,
        pendingProducers: [...chatOwners.values()].map((record) => ({
          tag: record.host.localName,
          producers: Object.fromEntries(record.pending),
        })),
      };
    },
  };
  let solidSidebarOwner: ProbeInit.SolidSidebarProbeOwner | undefined;
  const sidebarLifecycleOriginals = new Map<ProbeInit.SidebarLifecycle, () => void>();
  const sidebarPasses: Array<{ method: ProbeInit.SidebarLifecycle; kind: string; atMs: number }> =
    [];
  const sidebarLifecycle = lifecycleCounter();
  const sidebarOwnerStacks = new Map<string, number>();
  const OriginalWeakMap = window.WeakMap;
  class RegistrationWeakMap<K extends WeakKey, V> extends OriginalWeakMap<K, V> {
    override set(host: K, owner: V): this {
      super.set(host, owner);
      sidebarRegistration.capture(host, owner);
      return this;
    }
  }
  const sidebarRegistration = {
    matches(host: unknown, owner: unknown): owner is ProbeInit.SolidSidebarProbeOwner {
      return (
        matchesOwner(host, owner, "openclaw-app-sidebar", "hostElement") &&
        typeof owner.invalidate === "function" &&
        typeof owner.prepareRender === "function" &&
        typeof owner.commitRender === "function" &&
        isRecord(owner.sessionData) &&
        typeof owner.sessionData.requestSessionDataUpdate === "function"
      );
    },
    capture(host: WeakKey, owner: unknown) {
      if (sidebarRegistration.matches(host, owner)) {
        solidSidebarOwner = owner;
      }
      if (host instanceof HTMLElement && chatProbe.matches(host, owner)) {
        chatOwners.set(host, {
          host,
          owner,
          pending: new Map(),
          pendingRequests: new Map(),
        });
      }
      if (
        solidSidebarOwner &&
        [...chatOwners.keys()].some((chatHost) => chatHost.localName === "openclaw-chat-pane")
      ) {
        sidebarRegistration.restore();
      }
    },
    restore() {
      if (window.WeakMap === RegistrationWeakMap) {
        window.WeakMap = OriginalWeakMap;
      }
      // Existing maps inherit the native setter once registration capture is finished.
      Reflect.deleteProperty(RegistrationWeakMap.prototype, "set");
    },
  };
  // The init script precedes application modules, including their host→owner maps.
  if (input.ownerProbes !== false) {
    window.WeakMap = RegistrationWeakMap;
  }
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
  let liveStartedAt = 0;
  let liveRpcOffset = 0;
  let liveFinishedAt = 0;
  let liveKind = "idle";
  const recordStack = (counts: Map<string, number>, stack: string | undefined) => {
    const key = `${liveKind} :: ${stack?.split("\n").slice(2, 14).join(" <- ") ?? ""}`;
    if (counts.has(key) || counts.size < 100) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
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
            eventStream.observeRequest(frame);
          }
        }
        send(data);
      };
      socket.dispatchEvent = (event) => {
        if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
          return dispatch(event);
        }
        const frame = JSON.parse(event.data);
        const responseBytes = new TextEncoder().encode(event.data).length;
        const liveEvent = eventStream.emitting;
        // A single wire delivers one message task at a time, including concurrent RPC replies.
        nextFrameAt = Math.max(performance.now() + input.latencyMs, nextFrameAt + input.frameGapMs);
        queued++;
        window.setTimeout(
          () => {
            queued--;
            const request = pending.get(frame.id);
            const rpcIndex = rpcs.length;
            if (request) {
              pending.delete(frame.id);
              rpcs.push({
                method: request.method,
                params: request.params,
                stack: request.stack,
                requestBytes: request.bytes,
                responseBytes,
                ms: performance.now() - request.at,
                ...(liveStartedAt ? { responseAtMs: performance.now() - liveStartedAt } : {}),
              });
            }
            const responseMark = request && `cold-load-rpc:${rpcIndex}:${request.method}`;
            const delivery = liveEvent
              ? { ...liveEvent, deliveredAtMs: performance.now() - liveStartedAt }
              : null;
            if (delivery) {
              liveKind = delivery.kind;
              liveEvents.set(delivery.kind, (liveEvents.get(delivery.kind) ?? 0) + 1);
            }
            const dispatchStarted = performance.now();
            if (responseMark) {
              performance.mark(`${responseMark}:start`);
            }
            frameProbe.withDelivery(delivery, () => dispatch(event));
            if (request) {
              rpcs[rpcIndex]!.dispatchMs = performance.now() - dispatchStarted;
              performance.mark(`${responseMark}:end`);
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
      liveRpcOffset = rpcs.length;
      if (input.ownerProbes === false) {
        eventStream.startLive(liveStartedAt);
        return;
      }
      frameProbe.install();
      const sidebar = document.querySelector("openclaw-app-sidebar");
      sidebarRegistration.restore();
      chatProbe.install();
      if (sidebar && !solidSidebarOwner) {
        throw new Error("Solid sidebar owner registration was not captured");
      }
      if (solidSidebarOwner) {
        const owner = solidSidebarOwner;
        for (const method of ["invalidate", "prepareRender", "commitRender"] as const) {
          const original = owner[method];
          sidebarLifecycleOriginals.set(method, original);
          owner[method] = function (this: ProbeInit.SolidSidebarProbeOwner) {
            const connected = this.isConnected;
            if (method === "invalidate" && connected) {
              recordStack(sidebarOwnerStacks, new Error().stack);
            }
            const started = performance.now();
            try {
              return original.call(this);
            } finally {
              if (connected) {
                sidebarPasses.push({ method, kind: liveKind, atMs: started - liveStartedAt });
                sidebarLifecycle.record(method, performance.now() - started);
              }
            }
          };
        }
      }
      const owner: ProbeInit.SessionDataProbeOwner | undefined =
        solidSidebarOwner?.sessionData ??
        (sidebar ? Reflect.get(sidebar, "sessionData") : undefined);
      if (owner) {
        const original = owner.requestSessionDataUpdate;
        owner.requestSessionDataUpdate = function (...args: unknown[]) {
          recordStack(liveOrigins, new Error().stack);
          return original.apply(this, args);
        };
        liveInvalidatorOwner = owner;
        originalLiveInvalidator = original;
      }
      eventStream.startLive(liveStartedAt);
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
        rpcs: rpcs.slice(liveRpcOffset),
        rpcOffset: liveRpcOffset,
        sentEvents: [...liveEvents.values()].reduce((sum, count) => sum + count, 0),
        events: Object.fromEntries(liveEvents),
        deliveryCadence: frameProbe.readDeliveryCadence(),
        sidebarInvalidations: Object.fromEntries(liveOrigins),
        ownerProbes: input.ownerProbes !== false,
        solidChat: input.ownerProbes === false ? null : chatProbe.read(),
        solidSidebar: solidSidebarOwner
          ? {
              measurement: "owner-invalidations-and-projection-lifecycle-passes",
              passes: sidebarPasses,
              lifecycle: sidebarLifecycle.read(),
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
        queued: queued + eventStream.queued,
        sentEvents: eventStream.sentEvents,
        idleMs: performance.now() - lastActivity,
        rpcs,
        longTasks,
      };
    },
  });
}

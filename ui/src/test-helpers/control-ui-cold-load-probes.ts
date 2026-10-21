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
  const rpcs: Array<{
    method: string;
    requestBytes: number;
    responseBytes: number;
    ms: number;
    dispatchMs?: number;
    responseAtMs?: number;
    abandoned?: true;
    params: unknown;
    stack: string | undefined;
  }> = [];
  const pending = new Map<
    string,
    {
      socket: WebSocket;
      method: string;
      bytes: number;
      at: number;
      params: Record<string, unknown>;
      stack: string | undefined;
    }
  >();
  let lastActivity = performance.now();
  let queued = 0;
  let nextFrameAt = 0;
  const eventStream = createEventStream(input);
  const liveOrigins = new Map<string, number>();
  let liveInvalidatorOwner: ProbeInit.SessionDataProbeOwner | undefined;
  let originalLiveInvalidator: ProbeInit.ProbeMethod | undefined;
  const chatOwners = new Map<HTMLElement, ProbeInit.ChatOwnerRecord>();
  const chatLifecycle = new Map<string, Map<string, Map<string, { count: number; ms: number }>>>();
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
        host instanceof HTMLElement &&
        host.localName === "openclaw-chat-pane" &&
        typeof owner === "object" &&
        owner !== null &&
        "element" in owner &&
        owner.element === host &&
        "isConnected" in owner &&
        typeof owner.isConnected === "boolean" &&
        "render" in owner &&
        typeof owner.render === "function"
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
          [...chatLifecycle].map(([tag, kinds]) => [
            tag,
            Object.fromEntries(
              [...kinds].map(([kind, methods]) => [kind, Object.fromEntries(methods)]),
            ),
          ]),
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
  const sidebarHandoffs: Array<{ atMs: number; durationMs: number; frameMs?: number }> = [];
  let originalPublicationGate:
    | ProbeInit.SolidSidebarProbeOwner["shouldPublishSessionData"]
    | undefined;
  const sidebarCounts = {
    admissions: 0,
    publications: 0,
    invalidate: 0,
    prepareRender: 0,
    commitRender: 0,
  };
  const sidebarLifecycleOriginals = new Map<ProbeInit.SidebarLifecycle, () => void>();
  const sidebarPasses: Array<{ method: ProbeInit.SidebarLifecycle; kind: string; atMs: number }> =
    [];
  const sidebarLifecycle = new Map<
    string,
    Map<ProbeInit.SidebarLifecycle, { count: number; ms: number }>
  >();
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
        host instanceof HTMLElement &&
        host.localName === "openclaw-app-sidebar" &&
        typeof owner === "object" &&
        owner !== null &&
        "hostElement" in owner &&
        owner.hostElement === host &&
        "isConnected" in owner &&
        typeof owner.isConnected === "boolean" &&
        "invalidate" in owner &&
        typeof owner.invalidate === "function" &&
        "prepareRender" in owner &&
        typeof owner.prepareRender === "function" &&
        "commitRender" in owner &&
        typeof owner.commitRender === "function" &&
        "shouldPublishSessionData" in owner &&
        typeof owner.shouldPublishSessionData === "function" &&
        "sessionData" in owner &&
        typeof owner.sessionData === "object" &&
        owner.sessionData !== null &&
        "requestSessionDataUpdate" in owner.sessionData &&
        typeof owner.sessionData.requestSessionDataUpdate === "function"
      );
    },
    capture(host: WeakKey, owner: unknown) {
      if (sidebarRegistration.matches(host, owner) && owner !== solidSidebarOwner) {
        solidSidebarOwner = owner;
        const release = owner.releaseSidebarSnapshot.bind(owner);
        owner.releaseSidebarSnapshot = () => {
          const atMs = performance.now();
          release();
          const handoff: { atMs: number; durationMs: number; frameMs?: number } = {
            atMs,
            durationMs: performance.now() - atMs,
          };
          sidebarHandoffs.push(handoff);
          requestAnimationFrame(() => {
            handoff.frameMs = performance.now() - atMs;
          });
        };
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
  if (input.ownerProbes !== false || input.sidebarCounters) {
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
  const Original = window.WebSocket;
  window.WebSocket = new Proxy(Original, {
    construct(target, args) {
      // The mock constructor returns its routed socket rather than its own instance.
      const socket: WebSocket = Reflect.construct(target, args);
      // A closed transport cannot answer; count its attempts without blocking settlement.
      socket.addEventListener(
        "close",
        () => {
          for (const [id, request] of pending) {
            if (request.socket !== socket) {
              continue;
            }
            pending.delete(id);
            rpcs.push({
              method: request.method,
              params: request.params,
              stack: request.stack,
              requestBytes: request.bytes,
              responseBytes: 0,
              ms: performance.now() - request.at,
              abandoned: true,
            });
          }
          lastActivity = performance.now();
        },
        { once: true },
      );
      const send = socket.send.bind(socket);
      const dispatch = socket.dispatchEvent.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          const frame = JSON.parse(data);
          if (frame.type === "req") {
            const connectDelay = (input.connectNotBeforeMs ?? 0) - performance.now();
            if (frame.method === "connect" && connectDelay > 0) {
              queued++;
              window.setTimeout(() => {
                queued--;
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(data);
                }
              }, connectDelay);
              return;
            }
            pending.set(frame.id, {
              socket,
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
        let deliveredEvent = event;
        const frame = JSON.parse(event.data);
        const responseBytes = new TextEncoder().encode(event.data).length;
        const liveEvent = eventStream.emitting;
        // A single wire delivers one message task at a time, including concurrent RPC replies.
        nextFrameAt = Math.max(performance.now() + input.latencyMs, nextFrameAt + input.frameGapMs);
        const queuedRequest = pending.get(frame.id);
        if (input.omitHelloSelfPresence && queuedRequest?.method === "connect") {
          const client = queuedRequest.params.client;
          const instanceId =
            client && typeof client === "object" && "instanceId" in client
              ? client.instanceId
              : undefined;
          const presence = frame.payload?.snapshot?.presence;
          if (Array.isArray(presence)) {
            frame.payload.snapshot.presence = presence.filter(
              (entry) => entry.instanceId !== instanceId,
            );
            deliveredEvent = new MessageEvent("message", { data: JSON.stringify(frame) });
          }
        }
        const query = queuedRequest?.params;
        const queryKind =
          queuedRequest?.method !== "sessions.list"
            ? undefined
            : query?.ownerFirst
              ? "ownerFirst"
              : query?.involvingMe
                ? "involvingMe"
                : query?.includeOwnerSessionCounts
                  ? "ownerCounts"
                  : query?.spawnedBy
                    ? "children"
                    : undefined;
        // Per-method delay models a queued RPC without holding unrelated replies.
        const deliverAt = Math.max(
          nextFrameAt,
          queuedRequest
            ? queuedRequest.at +
                ((queryKind && input.sidebarQueryLatencyMs?.[queryKind]) ??
                  input.methodLatencyMs?.[queuedRequest.method] ??
                  0)
            : 0,
        );
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
            frameProbe.withDelivery(delivery, () => dispatch(deliveredEvent));
            if (request) {
              rpcs[rpcIndex]!.dispatchMs = performance.now() - dispatchStarted;
              performance.mark(`${responseMark}:end`);
            }
            lastActivity = performance.now();
          },
          Math.max(0, deliverAt - performance.now()),
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
      if (input.ownerProbes === false && !input.sidebarCounters) {
        eventStream.startLive(liveStartedAt);
        return;
      }
      if (input.ownerProbes !== false) {
        frameProbe.install();
        chatProbe.install();
      }
      const sidebar = document.querySelector("openclaw-app-sidebar");
      sidebarRegistration.restore();
      if (sidebar && !solidSidebarOwner) {
        throw new Error("Solid sidebar owner registration was not captured");
      }
      if (solidSidebarOwner) {
        const owner = solidSidebarOwner;
        const originalGate = owner.shouldPublishSessionData;
        originalPublicationGate = originalGate;
        owner.shouldPublishSessionData = function () {
          sidebarCounts.admissions++;
          const publish = originalGate.call(this);
          sidebarCounts.publications += Number(publish);
          return publish;
        };
        for (const method of ["invalidate", "prepareRender", "commitRender"] as const) {
          const original = owner[method];
          sidebarLifecycleOriginals.set(method, original);
          owner[method] = function (this: ProbeInit.SolidSidebarProbeOwner) {
            const connected = this.isConnected;
            if (connected) {
              sidebarCounts[method]++;
            }
            if (input.ownerProbes === false) {
              return original.call(this);
            }
            if (method === "invalidate" && connected) {
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
                sidebarPasses.push({ method, kind: liveKind, atMs: started - liveStartedAt });
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
      const owner: ProbeInit.SessionDataProbeOwner | undefined =
        solidSidebarOwner?.sessionData ??
        (sidebar ? Reflect.get(sidebar, "sessionData") : undefined);
      if (owner && input.ownerProbes !== false) {
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
      eventStream.startLive(liveStartedAt);
    },
    finishLive() {
      liveFinishedAt = performance.now();
      frameProbe.restore();
      sidebarRegistration.restore();
      chatProbe.restore();
      if (solidSidebarOwner) {
        if (originalPublicationGate) {
          solidSidebarOwner.shouldPublishSessionData = originalPublicationGate;
        }
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
        longTasks: longTasks.filter(
          (task) =>
            task.start >= liveStartedAt && (!liveFinishedAt || task.start <= liveFinishedAt),
        ),
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
              counts: sidebarCounts,
              passes: sidebarPasses,
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
        queued: queued + eventStream.queued,
        sentEvents: eventStream.sentEvents,
        idleMs: performance.now() - lastActivity,
        rpcs,
        longTasks,
        sidebarHandoffs,
      };
    },
  });
}

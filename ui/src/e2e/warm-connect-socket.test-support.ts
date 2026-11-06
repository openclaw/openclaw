type WarmConnectSocketEvent = {
  socket: number;
  atMs?: number;
  direction: "create" | "open" | "send" | "receive" | "close-request" | "close-event";
  type?: string;
  id?: string;
  method?: string;
  event?: string;
  ok?: boolean;
  errorCode?: string;
  code?: number;
  reason?: string;
};

declare global {
  interface Window {
    releaseWarmConnectIdentity?: () => void;
    warmConnectIdentityPending?: boolean;
    warmConnectSocketTrace?: {
      sockets: number;
      connects: number;
      closes: number;
      closeRequests: number;
      dropped: number;
      events: WarmConnectSocketEvent[];
    };
  }
}

/** Hold the native identity digest across reload without delaying the socket or cached rendering. */
export function installWarmConnectIdentityGate(): void {
  if (window !== window.top || sessionStorage.getItem("warm-connect-hold-identity") !== "1") {
    return;
  }
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const gate = Promise.withResolvers<void>();
  window.releaseWarmConnectIdentity = () => {
    sessionStorage.removeItem("warm-connect-hold-identity");
    gate.resolve();
  };
  crypto.subtle.digest = async (...args) => {
    window.warmConnectIdentityPending = true;
    await gate.promise;
    return digest(...args);
  };
}

/** Install before native sockets or after the mock transport; never retain frame bodies. */
export function installWarmConnectSocketTrace(): void {
  const trace = {
    sockets: 0,
    connects: 0,
    closes: 0,
    closeRequests: 0,
    dropped: 0,
    events: [] as WarmConnectSocketEvent[],
  };
  window.warmConnectSocketTrace = trace;
  const record = (entry: WarmConnectSocketEvent) => {
    if (trace.events.length === 2048) {
      trace.events.shift();
      trace.dropped++;
    }
    trace.events.push({ ...entry, atMs: performance.now() });
  };
  const frame = (socket: number, direction: "send" | "receive", data: unknown) => {
    if (typeof data !== "string") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return;
    }
    const value = parsed as Record<string, unknown>;
    const error =
      typeof value.error === "object" && value.error !== null
        ? (value.error as Record<string, unknown>)
        : undefined;
    if (direction === "send" && value.type === "req" && value.method === "connect") {
      trace.connects++;
    }
    record({
      socket,
      direction,
      ...(typeof value.type === "string" ? { type: value.type } : {}),
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(typeof value.method === "string" ? { method: value.method } : {}),
      ...(typeof value.event === "string" ? { event: value.event } : {}),
      ...(typeof value.ok === "boolean" ? { ok: value.ok } : {}),
      ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
    });
  };
  window.WebSocket = new Proxy(window.WebSocket, {
    construct(Target, args) {
      const socket = Reflect.construct(Target, args) as WebSocket;
      const id = ++trace.sockets;
      record({ socket: id, direction: "create" });
      const send = socket.send.bind(socket);
      const close = socket.close.bind(socket);
      socket.send = (data) => {
        frame(id, "send", data);
        send(data);
      };
      socket.close = (code, reason) => {
        trace.closeRequests++;
        record({ socket: id, direction: "close-request", code, reason });
        close(code, reason);
      };
      socket.addEventListener("open", () => record({ socket: id, direction: "open" }));
      socket.addEventListener("message", (event: MessageEvent) => frame(id, "receive", event.data));
      socket.addEventListener("close", (event: CloseEvent) => {
        trace.closes++;
        record({ socket: id, direction: "close-event", code: event.code, reason: event.reason });
      });
      return socket;
    },
  });
}

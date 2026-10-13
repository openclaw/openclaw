import { randomUUID } from "node:crypto";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type WebSocket from "ws";
import { sleepWithAbort } from "../infra/backoff.js";
import type { captureWsEventAsync } from "../proxy-capture/runtime.js";
import type { RealtimeVoiceBridgeCreateRequest } from "./provider-types.js";
import type {
  RealtimeVoiceSessionLifecycle,
  RealtimeVoiceSessionConnection,
} from "./realtime-session-lifecycle.js";

type SocketClose = { code: number; reason: string };
type ConnectionParams = { url: string; headers: Record<string, string> };
type RealtimeWireEvent = { type: string; error?: unknown };

/** Shared socket/retry ownership; provider authentication and event policy remain local. */
export class RealtimeVoiceWebSocketTransport<Event extends RealtimeWireEvent> {
  private ws: WebSocket | null = null;
  private connectionUrl = "";
  private readonly flowId = randomUUID();
  private terminalError: Error | undefined;
  private reconnectReason: string | undefined;

  constructor(
    private readonly options: {
      lifecycle: RealtimeVoiceSessionLifecycle;
      providerId: string;
      label: string;
      callbacks: Pick<RealtimeVoiceBridgeCreateRequest, "onError" | "onClose" | "onEvent">;
      resolveConnection: () => ConnectionParams | Promise<ConnectionParams>;
      createSocket: (connection: ConnectionParams) => WebSocket;
      capture?: typeof captureWsEventAsync;
      onOpen: (connection: RealtimeVoiceSessionConnection) => void;
      onEvent: (event: Event, connection: RealtimeVoiceSessionConnection) => void;
      onReset: () => void;
      startupError: (error: unknown, url: string) => Error;
      fatalEventError: (error: unknown, event?: Event) => SocketClose | undefined;
      startupLimit?: { bytes: number; message: string; reason: string };
      closeOnFailedAbort?: boolean;
      reconnectBlocked?: () => string | undefined;
      onFirstReconnect?: () => void;
      maxReconnectAttempts: number;
      reconnectDelayMs: number;
      connectTimeoutMs: number;
    },
  ) {}

  get socket(): WebSocket | null {
    return this.ws;
  }

  get lifecycle() {
    return this.options.lifecycle;
  }

  async connect(): Promise<void> {
    if (this.terminalError) {
      throw this.terminalError;
    }
    await this.lifecycle.connect((connection) => this.doConnect(connection));
  }

  isOpen(): boolean {
    return this.ws?.readyState === 1;
  }

  isConnected(): boolean {
    return this.lifecycle.isReady() && this.isOpen();
  }

  close(): void {
    const connection = this.lifecycle.currentConnection();
    if (!this.lifecycle.cancel()) {
      return;
    }
    this.options.onReset();
    if (!connection) {
      return;
    }
    const socket = this.ws;
    this.ws = null;
    if (socket && socket.readyState !== 3) {
      socket.close(1000, "Bridge closed");
    }
    this.notifyClose(connection, "completed");
  }

  rotate(reason: string): void {
    this.reconnectReason = reason;
    this.ws?.close(1000, `${reason} rotation`);
  }

  send(event: unknown, detail?: string): void {
    const socket = this.ws;
    if (socket?.readyState !== 1) {
      return;
    }
    const payload = JSON.stringify(event);
    const type =
      event && typeof event === "object" && "type" in event && typeof event.type === "string"
        ? event.type
        : "unknown";
    this.capture(this.connectionUrl, { direction: "outbound", kind: "ws-frame", payload });
    socket.send(payload);
    this.options.callbacks.onEvent?.({
      direction: "client",
      type,
      ...(detail ? { detail } : {}),
    });
  }

  fail(error: Error, connection: RealtimeVoiceSessionConnection, close: SocketClose): void {
    if (this.terminalError) {
      return;
    }
    const socket = this.ws;
    this.terminalError = error;
    if (!this.lifecycle.failure(connection)) {
      return;
    }
    this.options.onReset();
    try {
      this.options.callbacks.onError?.(error);
    } finally {
      if (socket && socket.readyState !== 3) {
        socket.close(close.code, close.reason);
      } else {
        this.notifyClose(connection, "error");
      }
    }
  }

  private notifyClose(connection: RealtimeVoiceSessionConnection, outcome: "completed" | "error") {
    const terminal = this.lifecycle.close(connection, outcome);
    if (!terminal) {
      return;
    }
    this.reconnectReason = undefined;
    this.options.onReset();
    this.options.callbacks.onClose?.(terminal);
  }

  private async doConnect(connection: RealtimeVoiceSessionConnection): Promise<void> {
    let socket: WebSocket | undefined;
    let startupBytes = 0;
    const attempt = this.lifecycle.createConnectAttempt({
      connection,
      timeoutMs: this.options.connectTimeoutMs,
      timeoutError: () => new Error(`${this.options.label} connection timeout`),
      onTimeout: () => socket?.terminate(),
      onAbort: (outcome) => {
        if (
          (this.options.closeOnFailedAbort || outcome !== "error") &&
          socket &&
          socket.readyState !== 3
        ) {
          socket.close(1000, "connection canceled");
        }
      },
    });
    const open = (params: ConnectionParams) => {
      if (attempt.settled) {
        return;
      }
      if (!this.lifecycle.isCurrent(connection) || connection.signal.aborted) {
        attempt.resolve();
        return;
      }
      attempt.startTimeout();
      const { url } = params;
      this.connectionUrl = url;
      const ws = this.options.createSocket(params);
      socket = ws;
      this.ws = ws;
      const rejectStartup = (error: unknown) => {
        const mapped = this.options.startupError(error, url);
        if (attempt.rejectStartup(mapped) && ws.readyState !== 3) {
          ws.close(1000, "startup failed");
        }
      };
      ws.on("open", () => {
        if (!this.lifecycle.acceptsEvents(connection)) {
          ws.close(1000, "stale connection");
          return;
        }
        this.capture(url, { direction: "local", kind: "ws-open" });
        this.options.onOpen(connection);
      });
      ws.on("message", (data: Buffer) => {
        if (
          !this.lifecycle.acceptsEvents(connection) ||
          this.ws !== ws ||
          (attempt.settled && !attempt.ready)
        ) {
          return;
        }
        const limit = this.options.startupLimit;
        if (!attempt.ready && limit) {
          startupBytes += data.byteLength;
          if (startupBytes > limit.bytes) {
            const error = new Error(limit.message);
            attempt.reject(error);
            this.fail(error, connection, { code: 1009, reason: limit.reason });
            return;
          }
        }
        this.capture(url, { direction: "inbound", kind: "ws-frame", payload: data });
        let event: Event | undefined;
        try {
          // SAFETY: Providers interpret their own wire union; this transport only routes its type.
          event = JSON.parse(data.toString()) as Event;
          if (event.type === "error" && !attempt.ready) {
            rejectStartup(event.error);
            return;
          }
          this.options.onEvent(event, connection);
          if (
            event.type === "session.updated" &&
            this.lifecycle.isCurrent(connection) &&
            this.lifecycle.isReady()
          ) {
            attempt.resolve(true);
          }
        } catch (error) {
          const close = this.options.fatalEventError(error, event);
          if (close) {
            const failure = toStringifiedError(error);
            attempt.reject(failure);
            this.fail(failure, connection, close);
          } else {
            console.error(`[${this.options.providerId}] realtime event parse failed:`, error);
          }
        }
      });
      ws.on("error", (error) => {
        if (!this.lifecycle.acceptsEvents(connection) || this.ws !== ws) {
          return;
        }
        this.capture(url, { direction: "local", kind: "error", errorText: error.message });
        if (!attempt.ready) {
          rejectStartup(toStringifiedError(error));
        } else {
          this.options.callbacks.onError?.(toStringifiedError(error));
        }
      });
      ws.on("close", (code, reasonBuffer) => {
        this.capture(url, {
          direction: "local",
          kind: "ws-close",
          closeCode: code,
          meta: { reason: reasonBuffer.length ? reasonBuffer.toString("utf8") : undefined },
        });
        if (!this.lifecycle.isCurrent(connection)) {
          return;
        }
        if (this.ws === ws) {
          this.ws = null;
        }
        if (attempt.startupFailed) {
          return;
        }
        if (this.terminalError) {
          this.notifyClose(connection, "error");
          return;
        }
        if (this.lifecycle.terminalOutcome(connection) === "completed") {
          attempt.resolve();
          this.notifyClose(connection, "completed");
          return;
        }
        if (!attempt.ready && !attempt.settled) {
          attempt.reject(new Error(`${this.options.label} connection closed before ready`));
          return;
        }
        const reason = this.reconnectReason ?? "websocket-close";
        this.reconnectReason = undefined;
        void this.attemptReconnect(reason, connection);
      });
    };
    try {
      const params = this.options.resolveConnection();
      // Already-resolved credentials preserve the provider's synchronous socket startup.
      if ("then" in params) {
        void params.then(open).catch((error: unknown) => {
          if (
            !this.lifecycle.isCurrent(connection) ||
            this.lifecycle.terminalOutcome(connection) === "completed"
          ) {
            attempt.resolve();
          } else {
            attempt.reject(toStringifiedError(error));
          }
        });
      } else {
        open(params);
      }
    } catch (error) {
      attempt.reject(toStringifiedError(error));
    }
    await attempt.promise;
  }

  private async attemptReconnect(
    reason: string,
    connection: RealtimeVoiceSessionConnection,
  ): Promise<void> {
    const blocked = this.options.reconnectBlocked?.();
    if (blocked) {
      this.options.callbacks.onEvent?.({
        direction: "client",
        type: "session.reconnect.blocked",
        detail: `reason=${reason} ${blocked}`,
      });
      this.endAfterReconnect(connection);
      return;
    }
    const retry = this.lifecycle.retry(connection, this.options.maxReconnectAttempts);
    if (!retry) {
      return;
    }
    if (retry === "exhausted") {
      this.options.callbacks.onEvent?.({
        direction: "client",
        type: "session.reconnect.exhausted",
        detail: `reason=${reason} attempts=${this.options.maxReconnectAttempts}`,
      });
      this.endAfterReconnect(connection);
      return;
    }
    const { attempt } = retry;
    const delay = this.options.reconnectDelayMs * 2 ** (attempt - 1);
    if (attempt === 1) {
      this.options.onFirstReconnect?.();
    }
    this.options.callbacks.onEvent?.({
      direction: "client",
      type: "session.reconnect.scheduled",
      detail: `reason=${reason} attempt=${attempt} delayMs=${delay}`,
    });
    try {
      await sleepWithAbort(delay, retry.signal);
    } catch (error) {
      if (!retry.signal.aborted) {
        throw error;
      }
      return;
    }
    const next = this.lifecycle.reconnect(connection);
    if (!next) {
      return;
    }
    try {
      await this.doConnect(next);
      if (!this.lifecycle.isCurrent(next) || !this.lifecycle.isReady()) {
        return;
      }
      this.options.callbacks.onEvent?.({
        direction: "client",
        type: "session.reconnect.ready",
        detail: `reason=${reason} attempt=${attempt}`,
      });
    } catch (error) {
      if (!this.lifecycle.acceptsEvents(next)) {
        return;
      }
      this.options.callbacks.onError?.(toStringifiedError(error));
      await this.attemptReconnect(reason, next);
    }
  }

  private endAfterReconnect(connection: RealtimeVoiceSessionConnection) {
    if (this.lifecycle.failure(connection)) {
      this.options.onReset();
    }
    this.notifyClose(connection, "error");
  }

  private capture(
    url: string,
    event: Omit<Parameters<typeof captureWsEventAsync>[0], "url" | "flowId">,
  ) {
    void this.options
      .capture?.({
        url,
        flowId: this.flowId,
        ...event,
        meta: { provider: this.options.providerId, capability: "realtime-voice", ...event.meta },
      })
      .catch(() => {});
  }
}

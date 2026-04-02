import type {
  ConnectOptions,
  ConnectionStatus,
  RPCEvent,
  ControlUIConfig,
} from "./types";

type EventHandler = (payload: unknown) => void;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 800;
  private maxReconnectDelay = 15000;
  private requestId = 0;
  private options: ConnectOptions | null = null;

  status: ConnectionStatus = "disconnected";
  onStatusChange?: (status: ConnectionStatus) => void;
  onSnapshot?: (snapshot: unknown) => void;
  onAuthError?: (message: string) => void;

  async fetchConfig(baseUrl: string): Promise<ControlUIConfig> {
    const res = await fetch(`${baseUrl}/__openclaw/control-ui-config.json`);
    return res.json();
  }

  connect(options: ConnectOptions): void {
    this.options = options;
    this.setStatus("connecting");

    const wsUrl = options.gatewayUrl.replace(/^http/, "ws");
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      // Wait for connect.challenge event
    };

    this.ws.onmessage = (event) => {
      const frame = JSON.parse(event.data);
      if (frame.type === "event") {
        this.handleEvent(frame);
      } else if (frame.type === "res") {
        this.handleResponse(frame);
      }
    };

    this.ws.onclose = () => {
      this.setStatus("disconnected");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.setStatus("error");
    };
  }

  private async handleEvent(frame: RPCEvent): Promise<void> {
    if (frame.event === "connect.challenge") {
      await this.authenticate(frame.payload as { nonce: string });
      return;
    }

    const handlers = this.eventHandlers.get(frame.event);
    if (handlers) {
      for (const handler of handlers) {
        handler(frame.payload);
      }
    }
  }

  private async authenticate(challenge: { nonce: string }): Promise<void> {
    if (!this.options) return;
    this.setStatus("authenticating");

    try {
      const { deviceIdentity, token, password } = this.options;
      const nonceBytes = new TextEncoder().encode(challenge.nonce);
      const signature = await deviceIdentity.sign(nonceBytes);

      const response = await this.rpc("connect", {
        auth: { token, password },
        device: {
          id: deviceIdentity.id,
          publicKey: deviceIdentity.publicKey,
          signature: Array.from(signature),
        },
        client: {
          id: "openclaw-control-ui",
          version: "2.0.0",
          platform: "web",
          mode: "webchat",
        },
        role: "operator",
        scopes: [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.pairing",
        ],
      });

      if (response) {
        this.setStatus("connected");
        this.reconnectDelay = 800;
        this.onSnapshot?.(response);
      }
    } catch (e) {
      this.setStatus("error");
      this.onAuthError?.(
        e instanceof Error ? e.message : "Authentication failed",
      );
    }
  }

  async rpc(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }

      const id = String(++this.requestId);
      this.pendingRequests.set(id, { resolve, reject });

      this.ws.send(
        JSON.stringify({
          type: "req",
          id,
          method,
          params,
        }),
      );

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 30000);
    });
  }

  private handleResponse(frame: {
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: { code: string; message: string };
  }): void {
    const pending = this.pendingRequests.get(frame.id);
    if (!pending) return;
    this.pendingRequests.delete(frame.id);

    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(new Error(frame.error?.message ?? "RPC error"));
    }
  }

  on(event: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
    return () => this.eventHandlers.get(event)?.delete(handler);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.options) {
        this.connect(this.options);
      }
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 1.5,
      this.maxReconnectDelay,
    );
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.onStatusChange?.(status);
  }
}

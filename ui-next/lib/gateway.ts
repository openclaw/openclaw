/**
 * Gateway WebSocket client for React.
 * Adapted from ui/src/ui/gateway.ts for use with React hooks.
 */

import {
  buildDeviceAuthPayload,
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "./device-auth";
import {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  type DeviceIdentity,
} from "./device-identity";

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export type GatewayErrorInfo = {
  code: string;
  message: string;
  details?: unknown;
};

export class GatewayRequestError extends Error {
  readonly gatewayCode: string;
  readonly details?: unknown;

  constructor(error: GatewayErrorInfo) {
    super(error.message);
    this.name = "GatewayRequestError";
    this.gatewayCode = error.code;
    this.details = error.details;
  }
}

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  server?: {
    version?: string;
    connId?: string;
  };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
    issuedAtMs?: number;
  };
  policy?: { tickIntervalMs?: number };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

export type GatewayClientOptions = {
  url: string;
  token?: string;
  password?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: GatewayEventFrame) => void;
  onClose?: (info: { code: number; reason: string; error?: GatewayErrorInfo }) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

const CONNECT_FAILED_CLOSE_CODE = 4008;

function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Singleton gateway client for non-React usage
let singletonClient: GatewayClient | null = null;

/**
 * Initialize the singleton gateway client.
 * Call this once at app startup before using requestGateway().
 */
export function initGatewayClient(opts: GatewayClientOptions): GatewayClient {
  if (singletonClient) {
    singletonClient.stop();
  }
  singletonClient = new GatewayClient(opts);
  singletonClient.start();
  return singletonClient;
}

/**
 * Get the current singleton gateway client.
 * Returns null if initGatewayClient() hasn't been called yet.
 */
export function getGatewayClient(): GatewayClient | null {
  return singletonClient;
}

/**
 * Request helper for non-React usage.
 * Uses the singleton gateway client initialized via initGatewayClient().
 * @throws {GatewayRequestError} if request fails
 * @throws {Error} if gateway is not connected
 */
export async function requestGateway<T = unknown>(
  method: string,
  params?: unknown,
): Promise<T> {
  if (!singletonClient) {
    throw new Error(
      "Gateway client not initialized. Call initGatewayClient() first or use useGateway() hook in React components.",
    );
  }
  return singletonClient.request<T>(method, params);
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private lastSeq: number | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 800;
  private pendingConnectError: GatewayErrorInfo | undefined;
  private eventListeners = new Set<(evt: GatewayEventFrame) => void>();

  constructor(private opts: GatewayClientOptions) {}

  /** Subscribe to all gateway events. Returns an unsubscribe function. */
  subscribeEvent(listener: (evt: GatewayEventFrame) => void): void {
    this.eventListeners.add(listener);
  }

  /** Unsubscribe a previously registered event listener. */
  unsubscribeEvent(listener: (evt: GatewayEventFrame) => void): void {
    this.eventListeners.delete(listener);
  }

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.pendingConnectError = undefined;
    this.flushPending(new Error("gateway client stopped"));
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect() {
    if (this.closed) {
      return;
    }

    this.ws = new WebSocket(this.opts.url);
    this.ws.addEventListener("open", () => this.queueConnect());
    this.ws.addEventListener("message", (ev) => this.handleMessage(String(ev.data ?? "")));
    this.ws.addEventListener("close", (ev) => {
      const reason = String(ev.reason ?? "");
      const connectError = this.pendingConnectError;
      this.pendingConnectError = undefined;
      this.ws = null;
      this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
      this.opts.onClose?.({ code: ev.code, reason, error: connectError });
      this.scheduleReconnect();
    });
    this.ws.addEventListener("error", () => {
      // ignored; close handler will fire
    });
  }

  private scheduleReconnect() {
    if (this.closed) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    setTimeout(() => this.connect(), delay);
  }

  private flushPending(err: Error) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private async sendConnect() {
    if (this.connectSent) {
      return;
    }
    this.connectSent = true;

    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    // crypto.subtle is only available in secure contexts (HTTPS, localhost).
    // Over plain HTTP, we skip device identity and fall back to token-only auth.
    const isSecureContext = typeof crypto !== "undefined" && !!crypto.subtle;

    const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
    const role = "operator";
    const clientId = "openclaw-control-ui";
    const clientMode = "ui";
    let deviceIdentity: DeviceIdentity | null = null;
    let canFallbackToShared = false;
    let authToken = this.opts.token;

    if (isSecureContext) {
      deviceIdentity = await loadOrCreateDeviceIdentity();
      const storedToken = loadDeviceAuthToken({
        deviceId: deviceIdentity.deviceId,
        role,
      })?.token;
      authToken = storedToken ?? this.opts.token;
      canFallbackToShared = Boolean(storedToken && this.opts.token);
    }

    const auth =
      authToken || this.opts.password
        ? { token: authToken, password: this.opts.password }
        : undefined;

    let device:
      | {
          id: string;
          publicKey: string;
          signature: string;
          signedAt: number;
          nonce: string;
        }
      | undefined;

    if (isSecureContext && deviceIdentity) {
      const signedAtMs = Date.now();
      const nonce = this.connectNonce ?? "";
      const payload = buildDeviceAuthPayload({
        deviceId: deviceIdentity.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAtMs,
        token: authToken ?? null,
        nonce,
      });
      const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
      device = {
        id: deviceIdentity.deviceId,
        publicKey: deviceIdentity.publicKey,
        signature,
        signedAt: signedAtMs,
        nonce,
      };
    }

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: clientId,
        version: "dev",
        platform: typeof navigator !== "undefined" ? (navigator.platform ?? "web") : "web",
        mode: clientMode,
      },
      role,
      scopes,
      device,
      caps: [],
      auth,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      locale: typeof navigator !== "undefined" ? navigator.language : "en",
    };

    try {
      const hello = await this.request<GatewayHelloOk>("connect", params);
      if (hello?.auth?.deviceToken && deviceIdentity) {
        storeDeviceAuthToken({
          deviceId: deviceIdentity.deviceId,
          role: hello.auth.role ?? role,
          token: hello.auth.deviceToken,
          scopes: hello.auth.scopes ?? [],
        });
      }
      this.backoffMs = 800;
      this.opts.onHello?.(hello);
    } catch (err: unknown) {
      if (err instanceof GatewayRequestError) {
        this.pendingConnectError = {
          code: err.gatewayCode,
          message: err.message,
          details: err.details,
        };
      } else {
        this.pendingConnectError = undefined;
      }
      if (canFallbackToShared && deviceIdentity) {
        clearDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role });
      }
      this.ws?.close(CONNECT_FAILED_CLOSE_CODE, "connect failed");
    }
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown };

    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;

      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: unknown } | undefined;
        const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          void this.sendConnect();
        }
        return;
      }

      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = seq;
      }

      try {
        this.opts.onEvent?.(evt);
      } catch (err) {
        console.error("[gateway] event handler error:", err);
      }
      // Forward to all subscribers registered via subscribeEvent()
      for (const listener of this.eventListeners) {
        try {
          listener(evt);
        } catch (err) {
          console.error("[gateway] subscriber error:", err);
        }
      }
      return;
    }

    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) {
        return;
      }

      this.pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(
          new GatewayRequestError({
            code: res.error?.code ?? "UNAVAILABLE",
            message: res.error?.message ?? "request failed",
            details: res.error?.details,
          }),
        );
      }
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }

    const id = generateUUID();
    const frame = { type: "req", id, method, params };
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
    });
    this.ws.send(JSON.stringify(frame));
    return p;
  }

  private queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
    }
    this.connectTimer = setTimeout(() => {
      void this.sendConnect();
    }, 750);
  }
}

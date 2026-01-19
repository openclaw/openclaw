import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { rawDataToString } from "../infra/ws.js";
import { logDebug, logError } from "../logger.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { publicKeyRawBase64UrlFromPem, signDevicePayload } from "../infra/device-identity.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import {
  type ConnectParams,
  type EventFrame,
  type HelloOk,
  PROTOCOL_VERSION,
  type RequestFrame,
  validateEventFrame,
  validateRequestFrame,
  validateResponseFrame,
} from "./protocol/index.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  expectFinal: boolean;
};

export type GatewayClientOptions = {
  url?: string; // ws://127.0.0.1:18789
  token?: string;
  password?: string;
  instanceId?: string;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  role?: string;
  scopes?: string[];
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  deviceIdentity?: DeviceIdentity;
  minProtocol?: number;
  maxProtocol?: number;
  tlsFingerprint?: string;
  onEvent?: (evt: EventFrame) => void;
  onHelloOk?: (hello: HelloOk) => void;
  onConnectError?: (err: Error) => void;
  onClose?: (code: number, reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

export const GATEWAY_CLOSE_CODE_HINTS: Readonly<Record<number, string>> = {
  1000: "normal closure",
  1006: "abnormal closure (no close frame)",
  1008: "policy violation",
  1012: "service restart",
};

export function describeGatewayCloseCode(code: number): string | undefined {
  return GATEWAY_CLOSE_CODE_HINTS[code];
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private opts: GatewayClientOptions;
  private pending = new Map<string, Pending>();
  private backoffMs = 1000;
  private closed = false;
  private lastSeq: number | null = null;
  // Track last tick to detect silent stalls.
  private lastTick: number | null = null;
  private tickIntervalMs = 30_000;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  start() {
    if (this.closed) return;
    const url = this.opts.url ?? "ws://127.0.0.1:18789";
    // Allow node screen snapshots and other large responses.
    const wsOptions: ConstructorParameters<typeof WebSocket>[1] = {
      maxPayload: 25 * 1024 * 1024,
    };
    if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
      wsOptions.rejectUnauthorized = false;
      wsOptions.checkServerIdentity = (_host, cert) => {
        const fingerprint = normalizeFingerprint(
          typeof cert?.fingerprint256 === "string" ? cert.fingerprint256 : "",
        );
        const expected = normalizeFingerprint(this.opts.tlsFingerprint ?? "");
        if (fingerprint && fingerprint === expected) return undefined;
        return new Error("gateway tls fingerprint mismatch");
      };
    }
    this.ws = new WebSocket(url, wsOptions);

    this.ws.on("open", () => this.sendConnect());
    this.ws.on("message", (data) => this.handleMessage(rawDataToString(data)));
    this.ws.on("close", (code, reason) => {
      const reasonText = rawDataToString(reason);
      this.ws = null;
      this.flushPendingErrors(new Error(`gateway closed (${code}): ${reasonText}`));
      this.scheduleReconnect();
      this.opts.onClose?.(code, reasonText);
    });
    this.ws.on("error", (err) => {
      logDebug(`gateway client error: ${String(err)}`);
    });
  }

  stop() {
    this.closed = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.flushPendingErrors(new Error("gateway client stopped"));
  }

  private sendConnect() {
    const auth =
      this.opts.token || this.opts.password
        ? {
            token: this.opts.token,
            password: this.opts.password,
          }
        : undefined;
    const signedAtMs = Date.now();
    const role = this.opts.role ?? "operator";
    const scopes = this.opts.scopes ?? ["operator.admin"];
    const device = (() => {
      if (!this.opts.deviceIdentity) return undefined;
      const payload = buildDeviceAuthPayload({
        deviceId: this.opts.deviceIdentity.deviceId,
        clientId: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientMode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
        role,
        scopes,
        signedAtMs,
        token: this.opts.token ?? null,
      });
      const signature = signDevicePayload(this.opts.deviceIdentity.privateKeyPem, payload);
      return {
        id: this.opts.deviceIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(this.opts.deviceIdentity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
      };
    })();
    const params: ConnectParams = {
      minProtocol: this.opts.minProtocol ?? PROTOCOL_VERSION,
      maxProtocol: this.opts.maxProtocol ?? PROTOCOL_VERSION,
      client: {
        id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        displayName: this.opts.clientDisplayName,
        version: this.opts.clientVersion ?? "dev",
        platform: this.opts.platform ?? process.platform,
        mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
        instanceId: this.opts.instanceId,
      },
      caps: Array.isArray(this.opts.caps) ? this.opts.caps : [],
      commands: Array.isArray(this.opts.commands) ? this.opts.commands : undefined,
      permissions:
        this.opts.permissions && typeof this.opts.permissions === "object"
          ? this.opts.permissions
          : undefined,
      auth,
      role,
      scopes,
      device,
    };

    void this.request<HelloOk>("connect", params)
      .then((helloOk) => {
        this.backoffMs = 1000;
        this.tickIntervalMs =
          typeof helloOk.policy?.tickIntervalMs === "number"
            ? helloOk.policy.tickIntervalMs
            : 30_000;
        this.lastTick = Date.now();
        this.startTickWatch();
        this.opts.onHelloOk?.(helloOk);
      })
      .catch((err) => {
        this.opts.onConnectError?.(err instanceof Error ? err : new Error(String(err)));
        const msg = `gateway connect failed: ${String(err)}`;
        if (this.opts.mode === GATEWAY_CLIENT_MODES.PROBE) logDebug(msg);
        else logError(msg);
        this.ws?.close(1008, "connect failed");
      });
  }

  private handleMessage(raw: string) {
    try {
      const parsed = JSON.parse(raw);
      if (validateEventFrame(parsed)) {
        const evt = parsed as EventFrame;
        const seq = typeof evt.seq === "number" ? evt.seq : null;
        if (seq !== null) {
          if (this.lastSeq !== null && seq > this.lastSeq + 1) {
            this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
          }
          this.lastSeq = seq;
        }
        if (evt.event === "tick") {
          this.lastTick = Date.now();
        }
        this.opts.onEvent?.(evt);
        return;
      }
      if (validateResponseFrame(parsed)) {
        const pending = this.pending.get(parsed.id);
        if (!pending) return;
        // If the payload is an ack with status accepted, keep waiting for final.
        const payload = parsed.payload as { status?: unknown } | undefined;
        const status = payload?.status;
        if (pending.expectFinal && status === "accepted") {
          return;
        }
        this.pending.delete(parsed.id);
        if (parsed.ok) pending.resolve(parsed.payload);
        else pending.reject(new Error(parsed.error?.message ?? "unknown error"));
      }
    } catch (err) {
      logDebug(`gateway client parse error: ${String(err)}`);
    }
  }

  private scheduleReconnect() {
    if (this.closed) return;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    setTimeout(() => this.start(), delay).unref();
  }

  private flushPendingErrors(err: Error) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private startTickWatch() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    const interval = Math.max(this.tickIntervalMs, 1000);
    this.tickTimer = setInterval(() => {
      if (this.closed) return;
      if (!this.lastTick) return;
      const gap = Date.now() - this.lastTick;
      if (gap > this.tickIntervalMs * 2) {
        this.ws?.close(4000, "tick timeout");
      }
    }, interval);
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }
    const id = randomUUID();
    const frame: RequestFrame = { type: "req", id, method, params };
    if (!validateRequestFrame(frame)) {
      throw new Error(
        `invalid request frame: ${JSON.stringify(validateRequestFrame.errors, null, 2)}`,
      );
    }
    const expectFinal = opts?.expectFinal === true;
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal,
      });
    });
    this.ws.send(JSON.stringify(frame));
    return p;
  }
}

function normalizeFingerprint(input: string): string {
  return input.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}

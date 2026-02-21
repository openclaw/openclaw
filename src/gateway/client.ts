import { randomUUID } from "node:crypto";
import { WebSocket, type ClientOptions, type CertMeta } from "ws";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "../infra/device-auth-store.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { clearDevicePairing } from "../infra/device-pairing.js";
import { normalizeFingerprint } from "../infra/tls/fingerprint.js";
import { rawDataToString } from "../infra/ws.js";
import { logDebug, logError } from "../logger.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { isSecureWebSocketUrl } from "./net.js";
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
  connectDelayMs?: number;
  tickWatchMinIntervalMs?: number;
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
  pathEnv?: string;
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
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: NodeJS.Timeout | null = null;
  // Track last tick to detect silent stalls.
  private lastTick: number | null = null;
  private tickIntervalMs = 30_000;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(opts: GatewayClientOptions) {
    this.opts = {
      ...opts,
      deviceIdentity: opts.deviceIdentity ?? loadOrCreateDeviceIdentity(),
    };
  }

  start() {
    if (this.closed) {
      return;
    }
    const url = this.opts.url ?? "ws://127.0.0.1:18789";
    if (this.opts.tlsFingerprint && !url.startsWith("wss://")) {
      this.opts.onConnectError?.(new Error("gateway tls fingerprint requires wss:// gateway url"));
      return;
    }

    // Security check: block ALL plaintext ws:// to non-loopback addresses (CWE-319, CVSS 9.8)
    // This protects both credentials AND chat/conversation data from MITM attacks.
    // Device tokens may be loaded later in sendConnect(), so we block regardless of hasCredentials.
    if (!isSecureWebSocketUrl(url)) {
      // Safe hostname extraction - avoid throwing on malformed URLs in error path
      let displayHost = url;
      try {
        displayHost = new URL(url).hostname || url;
      } catch {
        // Use raw URL if parsing fails
      }
      const error = new Error(
        `SECURITY ERROR: Cannot connect to "${displayHost}" over plaintext ws://. ` +
          "Both credentials and chat data would be exposed to network interception. " +
          "Use wss:// for the gateway URL, or connect via SSH tunnel to localhost.",
      );
      this.opts.onConnectError?.(error);
      return;
    }
    // Allow node screen snapshots and other large responses.
    const wsOptions: ClientOptions = {
      maxPayload: 25 * 1024 * 1024,
    };
    if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
      wsOptions.rejectUnauthorized = false;
      wsOptions.checkServerIdentity = ((_host: string, cert: CertMeta) => {
        const fingerprintValue =
          typeof cert === "object" && cert && "fingerprint256" in cert
            ? ((cert as { fingerprint256?: string }).fingerprint256 ?? "")
            : "";
        const fingerprint = normalizeFingerprint(
          typeof fingerprintValue === "string" ? fingerprintValue : "",
        );
        const expected = normalizeFingerprint(this.opts.tlsFingerprint ?? "");
        if (!expected) {
          return new Error("gateway tls fingerprint missing");
        }
        if (!fingerprint) {
          return new Error("gateway tls fingerprint unavailable");
        }
        if (fingerprint !== expected) {
          return new Error("gateway tls fingerprint mismatch");
        }
        return undefined;
        // oxlint-disable-next-line typescript/no-explicit-any
      }) as any;
    }
    this.ws = new WebSocket(url, wsOptions);

    this.ws.on("open", () => {
      if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
        const tlsError = this.validateTlsFingerprint();
        if (tlsError) {
          this.opts.onConnectError?.(tlsError);
          this.ws?.close(1008, tlsError.message);
          return;
        }
      }
      this.queueConnect();
    });
    this.ws.on("message", (data) => this.handleMessage(rawDataToString(data)));
    this.ws.on("close", (code, reason) => {
      const reasonText = rawDataToString(reason);
      this.ws = null;
      // If closed due to device token mismatch, clear the stored token and pairing so next attempt can get a fresh one
      if (
        code === 1008 &&
        reasonText.toLowerCase().includes("device token mismatch") &&
        this.opts.deviceIdentity
      ) {
        const deviceId = this.opts.deviceIdentity.deviceId;
        const role = this.opts.role ?? "operator";
        try {
          clearDeviceAuthToken({ deviceId, role });
          void clearDevicePairing(deviceId).catch((err) => {
            logDebug(`failed clearing stale device pairing for device ${deviceId}: ${String(err)}`);
          });
          logDebug(`cleared stale device-auth token for device ${deviceId}`);
        } catch (err) {
          logDebug(
            `failed clearing stale device-auth token for device ${deviceId}: ${String(err)}`,
          );
        }
      }
      this.flushPendingErrors(new Error(`gateway closed (${code}): ${reasonText}`));
      this.scheduleReconnect();
      this.opts.onClose?.(code, reasonText);
    });
    this.ws.on("error", (err) => {
      logDebug(`gateway client error: ${String(err)}`);
      if (!this.connectSent) {
        this.opts.onConnectError?.(err instanceof Error ? err : new Error(String(err)));
      }
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
    if (this.connectSent) {
      return;
    }
    this.connectSent = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    const role = this.opts.role ?? "operator";
    const storedToken = this.opts.deviceIdentity
      ? loadDeviceAuthToken({ deviceId: this.opts.deviceIdentity.deviceId, role })?.token
      : null;
    // Prefer explicitly provided credentials (e.g. CLI `--token`) over any persisted
    // device-auth tokens. Persisted tokens are only used when no token is provided.
    const authToken = this.opts.token ?? storedToken ?? undefined;
    const auth =
      authToken || this.opts.password
        ? {
            token: authToken,
            password: this.opts.password,
          }
        : undefined;
    const signedAtMs = Date.now();
    const nonce = this.connectNonce ?? undefined;
    const scopes = this.opts.scopes ?? ["operator.admin"];
    const device = (() => {
      if (!this.opts.deviceIdentity) {
        return undefined;
      }
      const payload = buildDeviceAuthPayload({
        deviceId: this.opts.deviceIdentity.deviceId,
        clientId: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientMode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
        role,
        scopes,
        signedAtMs,
        token: authToken ?? null,
        nonce,
      });
      const signature = signDevicePayload(this.opts.deviceIdentity.privateKeyPem, payload);
      return {
        id: this.opts.deviceIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(this.opts.deviceIdentity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce,
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
      pathEnv: this.opts.pathEnv,
      auth,
      role,
      scopes,
      device,
    };

    void this.request<HelloOk>("connect", params)
      .then((helloOk) => {
        const authInfo = helloOk?.auth;
        if (authInfo?.deviceToken && this.opts.deviceIdentity) {
          storeDeviceAuthToken({
            deviceId: this.opts.deviceIdentity.deviceId,
            role: authInfo.role ?? role,
            token: authInfo.deviceToken,
            scopes: authInfo.scopes ?? [],
          });
        }
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
        if (this.opts.mode === GATEWAY_CLIENT_MODES.PROBE) {
          logDebug(msg);
        } else {
          logError(msg);
        }
        this.ws?.close(1008, "connect failed");
      });
  }

  private handleMessage(raw: string) {
    try {
      const parsed = JSON.parse(raw);
      if (validateEventFrame(parsed)) {
        const evt = parsed;
        if (evt.event === "connect.challenge") {
          const payload = evt.payload as { nonce?: unknown } | undefined;
          const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
          if (nonce) {
            this.connectNonce = nonce;
            this.sendConnect();
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
        if (evt.event === "tick") {
          this.lastTick = Date.now();
        }
        this.opts.onEvent?.(evt);
        return;
      }
      if (validateResponseFrame(parsed)) {
        const pending = this.pending.get(parsed.id);
        if (!pending) {
          return;
        }
        // If the payload is an ack with status accepted, keep waiting for final.
        const payload = parsed.payload as { status?: unknown } | undefined;
        const status = payload?.status;
        if (pending.expectFinal && status === "accepted") {
          return;
        }
        this.pending.delete(parsed.id);
        if (parsed.ok) {
          pending.resolve(parsed.payload);
        } else {
          pending.reject(new Error(parsed.error?.message ?? "unknown error"));
        }
      }
    } catch (err) {
      logDebug(`gateway client parse error: ${String(err)}`);
    }
  }

  private queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    const rawConnectDelayMs = this.opts.connectDelayMs;
    const connectDelayMs =
      typeof rawConnectDelayMs === "number" && Number.isFinite(rawConnectDelayMs)
        ? Math.max(0, Math.min(5_000, rawConnectDelayMs))
        : 750;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
    }
    this.connectTimer = setTimeout(() => {
      this.sendConnect();
    }, connectDelayMs);
  }

  private scheduleReconnect() {
    if (this.closed) {
      return;
    }
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
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
    }
    const rawMinInterval = this.opts.tickWatchMinIntervalMs;
    const minInterval =
      typeof rawMinInterval === "number" && Number.isFinite(rawMinInterval)
        ? Math.max(1, Math.min(30_000, rawMinInterval))
        : 1000;
    const interval = Math.max(this.tickIntervalMs, minInterval);
    this.tickTimer = setInterval(() => {
      if (this.closed) {
        return;
      }
      if (!this.lastTick) {
        return;
      }
      const gap = Date.now() - this.lastTick;
      if (gap > this.tickIntervalMs * 2) {
        this.ws?.close(4000, "tick timeout");
      }
    }, interval);
  }

  private validateTlsFingerprint(): Error | null {
    if (!this.opts.tlsFingerprint || !this.ws) {
      return null;
    }
    const expected = normalizeFingerprint(this.opts.tlsFingerprint);
    if (!expected) {
      return new Error("gateway tls fingerprint missing");
    }
    const socket = (
      this.ws as WebSocket & {
        _socket?: { getPeerCertificate?: () => { fingerprint256?: string } };
      }
    )._socket;
    if (!socket || typeof socket.getPeerCertificate !== "function") {
      return new Error("gateway tls fingerprint unavailable");
    }
    const cert = socket.getPeerCertificate();
    const fingerprint = normalizeFingerprint(cert?.fingerprint256 ?? "");
    if (!fingerprint) {
      return new Error("gateway tls fingerprint unavailable");
    }
    if (fingerprint !== expected) {
      return new Error("gateway tls fingerprint mismatch");
    }
    return null;
  }

  async request<T = Record<string, unknown>>(
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

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { logDebug, logError } from "../logger.js";
import {
  type EventFrame,
  type Hello,
  type HelloOk,
  PROTOCOL_VERSION,
  type RequestFrame,
  validateRequestFrame,
} from "./protocol/index.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  expectFinal: boolean;
};

export type GatewayClientOptions = {
  url?: string; // ws://127.0.0.1:18789
  token?: string;
  instanceId?: string;
  clientName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: string;
  minProtocol?: number;
  maxProtocol?: number;
  onEvent?: (evt: EventFrame) => void;
  onHelloOk?: (hello: HelloOk) => void;
  onClose?: (code: number, reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private opts: GatewayClientOptions;
  private pending = new Map<string, Pending>();
  private backoffMs = 1000;
  private closed = false;
  private lastSeq: number | null = null;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  start() {
    if (this.closed) return;
    const url = this.opts.url ?? "ws://127.0.0.1:18789";
    this.ws = new WebSocket(url, { maxPayload: 512 * 1024 });

    this.ws.on("open", () => this.sendHello());
    this.ws.on("message", (data) => this.handleMessage(data.toString()));
    this.ws.on("close", (code, reason) => {
      this.ws = null;
      this.flushPendingErrors(
        new Error(`gateway closed (${code}): ${reason.toString()}`),
      );
      this.scheduleReconnect();
      this.opts.onClose?.(code, reason.toString());
    });
    this.ws.on("error", (err) => {
      logDebug(`gateway client error: ${String(err)}`);
    });
  }

  stop() {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.flushPendingErrors(new Error("gateway client stopped"));
  }

  private sendHello() {
    const hello: Hello = {
      type: "hello",
      minProtocol: this.opts.minProtocol ?? PROTOCOL_VERSION,
      maxProtocol: this.opts.maxProtocol ?? PROTOCOL_VERSION,
      client: {
        name: this.opts.clientName ?? "webchat-backend",
        version: this.opts.clientVersion ?? "dev",
        platform: this.opts.platform ?? process.platform,
        mode: this.opts.mode ?? "backend",
        instanceId: this.opts.instanceId,
      },
      caps: [],
      auth: this.opts.token ? { token: this.opts.token } : undefined,
    };
    this.ws?.send(JSON.stringify(hello));
  }

  private handleMessage(raw: string) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.type === "hello-ok") {
        this.backoffMs = 1000;
        this.opts.onHelloOk?.(parsed as HelloOk);
        return;
      }
      if (parsed?.type === "hello-error") {
        logError(`gateway hello-error: ${parsed.reason}`);
        this.ws?.close(1008, "hello-error");
        return;
      }
      if (parsed?.type === "event") {
        const evt = parsed as EventFrame;
        const seq = typeof evt.seq === "number" ? evt.seq : null;
        if (seq !== null) {
          if (this.lastSeq !== null && seq > this.lastSeq + 1) {
            this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
          }
          this.lastSeq = seq;
        }
        this.opts.onEvent?.(evt);
        return;
      }
      if (parsed?.type === "res") {
        const pending = this.pending.get(parsed.id);
        if (!pending) return;
        // If the payload is an ack with status accepted, keep waiting for final.
        const status = parsed.payload?.status;
        if (pending.expectFinal && status === "accepted") {
          return;
        }
        this.pending.delete(parsed.id);
        if (parsed.ok) pending.resolve(parsed.payload);
        else
          pending.reject(new Error(parsed.error?.message ?? "unknown error"));
      }
    } catch (err) {
      logDebug(`gateway client parse error: ${String(err)}`);
    }
  }

  private scheduleReconnect() {
    if (this.closed) return;
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
        `invalid request frame: ${JSON.stringify(
          validateRequestFrame.errors,
          null,
          2,
        )}`,
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

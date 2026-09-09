import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { MAX_BUFFERED_BYTES, MAX_PAYLOAD_BYTES } from "../server-constants.js";
import type {
  GatewayConnectionDelivery,
  GatewayConnectionFrame,
  GatewayConnectionIngress,
  GatewayConnectionTransport,
} from "./connection-transport.js";
import {
  OPERATOR_HTTP_LIMITS,
  type OperatorHttpClosed,
  type OperatorHttpPollResponse,
} from "./operator-http-contract.js";
import type { GatewayOperatorHttpIngress } from "./operator-http-ingress.js";
import type { GatewayWsClient } from "./ws-types.js";

const MAX_ABORTED_DELIVERIES = 3;

type QueuedFrame = {
  cursor: number;
  frame: unknown;
  bytes: number;
  callback?: (error?: Error) => void;
  delivery?: GatewayConnectionDelivery;
};
type ConnectionOwner = {
  getClient: () => GatewayWsClient | null;
  isClosed: () => boolean;
  close: (code?: number, reason?: string) => void;
};
type Poll = {
  response: ServerResponse;
  ingress: GatewayOperatorHttpIngress;
  timer?: ReturnType<typeof setTimeout>;
  finish: () => void;
  writing: boolean;
  batch?: QueuedFrame[];
};

/** One ephemeral logical connection. HTTP receipt and peer ACK are distinct boundaries. */
export class GatewayOperatorHttpTransport
  extends EventEmitter
  implements GatewayConnectionTransport
{
  readyState = 1;
  bufferedAmount = 0;
  acceptedClientSeq = 0;
  private lastFrame?: string;
  private cursor = 0;
  private deliveredCursor = 0;
  private acknowledgedCursor = 0;
  private queue: QueuedFrame[] = [];
  private poll?: Poll;
  private owner?: ConnectionOwner;
  private abortedDeliveries = 0;
  private closed?: OperatorHttpClosed;
  private disposed = false;
  private readonly frameIngress = new WeakMap<GatewayConnectionFrame, GatewayConnectionIngress>();
  private idleTimer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly initialIngress: GatewayOperatorHttpIngress,
    private readonly remove: () => void,
  ) {
    super();
    this.idleTimer = setTimeout(() => this.expire(), OPERATOR_HTTP_LIMITS.idleTimeoutMs);
    this.idleTimer.unref();
  }

  bindOwner(owner: ConnectionOwner): void {
    this.owner = owner;
  }

  resolveFrameIngress = (data: GatewayConnectionFrame): GatewayConnectionIngress => {
    const ingress = this.frameIngress.get(data);
    if (!ingress) {
      throw new Error("Missing operator HTTP frame ingress");
    }
    return ingress;
  };

  get authenticated(): boolean {
    return Boolean(this.owner?.getClient());
  }

  private expire(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.close(1001, "connection expired");
    clearTimeout(this.idleTimer);
    const retained = this.queue;
    this.queue = [];
    this.bufferedAmount = 0;
    if (this.poll?.writing) {
      this.poll.response.destroy();
    }
    for (const entry of retained) {
      const callback = entry.callback;
      entry.callback = undefined;
      callback?.(new Error("Terminal delivery expired"));
    }
    this.remove();
  }

  private touch(): void {
    if (!this.closed) {
      this.idleTimer.refresh();
    }
  }

  private authorityCurrent(): boolean {
    const client = this.owner?.getClient();
    return (
      !this.closed &&
      this.owner?.isClosed() !== true &&
      !client?.invalidated &&
      this.initialIngress.isCurrent()
    );
  }

  admit(ingress: GatewayOperatorHttpIngress): boolean {
    if (
      ingress.binding !== this.initialIngress.binding ||
      !ingress.isCurrent() ||
      (!this.closed && !this.authorityCurrent())
    ) {
      this.close(4001, "connection ingress or authority changed");
      return false;
    }
    this.touch();
    return true;
  }

  acknowledge(ack: number): boolean {
    if (ack < this.acknowledgedCursor || ack > this.deliveredCursor) {
      return false;
    }
    this.acknowledgedCursor = ack;
    while (this.queue[0] && this.queue[0].cursor <= ack) {
      this.bufferedAmount -= this.queue.shift()!.bytes;
    }
    return true;
  }

  accept(clientSeq: number, frame: string, ingress: GatewayOperatorHttpIngress): boolean {
    if (this.closed) {
      return false;
    }
    const fingerprint = createHash("sha256").update(frame).digest("hex");
    if (clientSeq === this.acceptedClientSeq) {
      return fingerprint === this.lastFrame;
    }
    if (clientSeq !== this.acceptedClientSeq + 1) {
      return false;
    }
    // Reserve before emitting: a retry cannot dispatch while the first copy awaits.
    this.acceptedClientSeq = clientSeq;
    this.lastFrame = fingerprint;
    const data = Buffer.from(frame);
    this.frameIngress.set(data, ingress);
    this.emit("message", data);
    return true;
  }

  send(frame: string, callback?: (error?: Error) => void): void {
    this.sendWithContext(frame, callback, undefined);
  }

  sendWithContext(
    encoded: string,
    callback: ((error?: Error) => void) | undefined,
    delivery: GatewayConnectionDelivery | undefined,
  ): void {
    if (!this.authorityCurrent() || delivery?.isCurrent?.() === false) {
      callback?.(new Error("Connection retired before delivery"));
      this.close(4001, "connection authority changed");
      return;
    }
    const bytes = Buffer.byteLength(encoded);
    if (
      bytes > MAX_PAYLOAD_BYTES ||
      this.bufferedAmount + bytes > MAX_BUFFERED_BYTES ||
      this.queue.length >= OPERATOR_HTTP_LIMITS.maxQueuedFrames
    ) {
      callback?.(new Error("Operator HTTP output overflow"));
      this.close(1009, "output overflow; resync required");
      return;
    }
    this.queue.push({
      cursor: ++this.cursor,
      frame: JSON.parse(encoded),
      bytes,
      callback,
      delivery,
    });
    this.bufferedAmount += bytes;
    this.flushPoll();
  }

  async pollFrames(
    response: ServerResponse,
    ingress: GatewayOperatorHttpIngress,
    waitMs: number,
  ): Promise<boolean> {
    if (this.poll) {
      return false;
    }
    await new Promise<void>((resolve) => {
      const poll: Poll = { response, ingress, finish: resolve, writing: false };
      this.poll = poll;
      const cancelled = () => {
        if (this.poll !== poll) {
          return;
        }
        this.releasePoll(poll);
        if (poll.writing && ++this.abortedDeliveries >= MAX_ABORTED_DELIVERIES) {
          this.close(1006, "delivery failed; resync required");
        }
      };
      response.once("close", cancelled);
      response.once("error", cancelled);
      poll.finish = () => {
        response.off("close", cancelled);
        response.off("error", cancelled);
        resolve();
      };
      if (waitMs > 0) {
        poll.timer = setTimeout(() => this.flushPoll(true), waitMs);
        poll.timer.unref();
      }
      this.flushPoll(waitMs === 0);
    });
    return true;
  }

  private releasePoll(poll: Poll): void {
    clearTimeout(poll.timer);
    if (this.poll === poll) {
      this.poll = undefined;
    }
    poll.finish();
  }

  private flushPoll(force = false): void {
    const poll = this.poll;
    if (!poll || poll.writing) {
      return;
    }
    if (
      !this.closed &&
      (!poll.ingress.isCurrent() ||
        !this.authorityCurrent() ||
        this.queue.some((entry) => entry.delivery?.isCurrent?.() === false))
    ) {
      this.close(4001, "connection authority changed");
      return;
    }
    if (!force && !this.closed && this.queue.length === 0) {
      return;
    }
    const batch = this.queue.slice(0, OPERATOR_HTTP_LIMITS.maxBatchFrames);
    const response = poll.response;
    if (response.destroyed) {
      this.releasePoll(poll);
      return;
    }
    poll.writing = true;
    poll.batch = batch;
    clearTimeout(poll.timer);
    response.once("finish", () => {
      if (this.poll !== poll) {
        return;
      }
      this.abortedDeliveries = 0;
      this.releasePoll(poll);
      for (const entry of batch) {
        if (!this.queue.includes(entry)) {
          continue;
        }
        this.deliveredCursor = Math.max(this.deliveredCursor, entry.cursor);
        const callback = entry.callback;
        entry.callback = undefined;
        callback?.();
      }
    });
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    const body: OperatorHttpPollResponse = {
      acceptedClientSeq: this.acceptedClientSeq,
      frames: batch.map(({ cursor, frame }) => ({ cursor, frame })),
      ...(this.closed ? { closed: this.closed } : {}),
    };
    response.end(JSON.stringify(body));
  }

  close(code = 1000, reason = "connection closed"): void {
    if (this.closed) {
      return;
    }
    this.closed = { code, reason, resyncRequired: true };
    this.readyState = 3;
    clearTimeout(this.idleTimer);
    // Rejections are explicitly classified by the handshake owner. No response
    // shape, request id or credential-looking payload can authorize terminal replay.
    const terminal = this.owner?.getClient()
      ? []
      : this.queue.filter((entry) => entry.delivery?.rejectedHandshake).slice(0, 1);
    const discarded = this.queue.filter((entry) => !terminal.includes(entry));
    this.queue = terminal;
    this.bufferedAmount = terminal.reduce((total, entry) => total + entry.bytes, 0);
    if (this.poll?.writing && this.poll.batch?.some((entry) => !terminal.includes(entry))) {
      this.poll.response.destroy();
    }
    for (const entry of discarded) {
      const callback = entry.callback;
      entry.callback = undefined;
      callback?.(new Error("Connection retired before delivery"));
    }
    this.emit("close", code, Buffer.from(reason));
    this.flushPoll(true);
    // Failing a queued callback can synchronously terminate this transport.
    if (!this.disposed) {
      this.idleTimer = setTimeout(() => this.expire(), OPERATOR_HTTP_LIMITS.idleTimeoutMs);
      this.idleTimer.unref();
    }
  }

  terminate(): void {
    this.close(1006, "connection terminated");
    this.expire();
  }
}

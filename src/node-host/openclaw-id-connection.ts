import { sleepWithAbort } from "@openclaw/retry";
import type { Connection, Endpoint } from "../../crates/openclaw-iroh-node/index.js";
import {
  ADMISSION_WAIT_MS,
  CONNECTION_CLOSE,
  LIVENESS_PROBE_TIMEOUT_MS,
  LIVENESS_REPROBE_MS,
  LIVENESS_SILENCE_MS,
  RELAY_DENIAL_BACKOFF_INITIAL_MS,
  RELAY_DENIAL_BACKOFF_MAX_MS,
  TUNNEL_ALPN,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { NodeDiscoveryError, OpenClawIdNodeRemovedError } from "./openclaw-id-discovery.js";

/** One authenticated connection shared by the host's WS and HTTP streams. */
export class NodeTunnelConnection {
  private current?: Promise<Connection>;
  private connected?: Connection;
  private lastProbe = 0;
  private terminal?: Error;
  private readonly abort = new AbortController();
  private backoff = RELAY_DENIAL_BACKOFF_INITIAL_MS;
  private nextDialAt = 0;
  private probing = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: {
      endpoint: Endpoint;
      resolveTarget: (signal: AbortSignal) => Promise<{ serverKey: string; relayUrl?: string }>;
      directAddrs?: string[];
      onTerminal: (error: Error) => void;
    },
  ) {
    this.timer = setInterval(() => void this.probe(), LIVENESS_SILENCE_MS);
    this.timer.unref();
  }

  pathKind(): string {
    return this.connected?.pathKind() ?? "none";
  }

  private checkStopped(): void {
    this.abort.signal.throwIfAborted();
    if (this.terminal) {
      throw this.terminal;
    }
  }

  private nodeRemoved(): never {
    if (!this.terminal) {
      this.terminal = new OpenClawIdNodeRemovedError();
      this.options.onTerminal(this.terminal);
    }
    throw this.terminal;
  }

  private checkClosed(code?: number): void {
    if (code === CONNECTION_CLOSE.not_a_member || code === CONNECTION_CLOSE.revoked) {
      this.nodeRemoved();
    }
  }

  private async dial(): Promise<Connection> {
    this.checkStopped();
    await sleepWithAbort(Math.max(0, this.nextDialAt - Date.now()), this.abort.signal);
    this.checkStopped();
    const target = await this.options.resolveTarget(this.abort.signal).catch((error: unknown) => {
      if (error instanceof OpenClawIdNodeRemovedError) {
        this.nodeRemoved();
      }
      if (error instanceof NodeDiscoveryError) {
        this.nextDialAt = Date.now() + Math.max(this.backoff, error.retryAfterMs);
        this.backoff = Math.min(this.backoff * 2, RELAY_DENIAL_BACKOFF_MAX_MS);
      }
      throw error;
    });
    this.checkStopped();
    if (this.connected && this.connected.remoteId() !== target.serverKey.slice(5)) {
      this.connected.close(CONNECTION_CLOSE.claw_lost, "server authority changed");
    }
    const pending = this.options.endpoint.connect(
      target.serverKey.slice(5),
      Buffer.from(TUNNEL_ALPN),
      {
        relayUrl: target.relayUrl,
        directAddrs: this.options.directAddrs,
      },
    );
    // napi connect has no abort parameter. Close a late result rather than leaking a probe.
    let expired = false;
    const timeout = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, timeout.signal]);
    const deadline = sleepWithAbort(LIVENESS_PROBE_TIMEOUT_MS, signal).then(() => {
      expired = true;
      throw new Error("OpenClaw ID tunnel handshake timed out");
    });
    void pending.then(
      (conn) => {
        if (expired || this.abort.signal.aborted) {
          conn.close(CONNECTION_CLOSE.claw_lost, "dial cancelled");
        }
      },
      () => {},
    );
    try {
      const conn = await Promise.race([pending, deadline]);
      const close = await Promise.race([
        conn.closed(),
        sleepWithAbort(ADMISSION_WAIT_MS, this.abort.signal),
      ]);
      if (close) {
        this.checkClosed(close.code);
        throw new Error("OpenClaw ID tunnel closed before admission");
      }
      this.backoff = RELAY_DENIAL_BACKOFF_INITIAL_MS;
      this.nextDialAt = 0;
      return conn;
    } catch (error) {
      if (this.options.endpoint.homeRelayStatus().some((status) => status.authDeniedReason)) {
        this.nextDialAt = Date.now() + this.backoff;
        this.backoff = Math.min(this.backoff * 2, RELAY_DENIAL_BACKOFF_MAX_MS);
      }
      throw error;
    } finally {
      timeout.abort();
    }
  }

  async connection(): Promise<Connection> {
    this.checkStopped();
    if (!this.current) {
      const pending = this.dial();
      this.current = pending;
      void pending.then(
        (conn) => {
          this.connected = conn;
          return conn.closed().then((close) => {
            if (this.current === pending) {
              this.current = undefined;
              this.connected = undefined;
            }
            try {
              this.checkClosed(close.code);
            } catch {
              // onTerminal owns the visible error and stops the node host.
            }
          });
        },
        () => {
          if (this.current === pending) {
            this.current = undefined;
          }
        },
      );
    }
    return this.current;
  }

  private async probe(): Promise<void> {
    if (
      !this.connected ||
      Date.now() - this.lastProbe < LIVENESS_REPROBE_MS ||
      this.probing ||
      this.terminal ||
      this.abort.signal.aborted
    ) {
      return;
    }
    this.probing = true;
    this.lastProbe = Date.now();
    const current = this.connected;
    try {
      const probe = await this.dial();
      probe.close(CONNECTION_CLOSE.shutdown, "probe complete");
    } catch {
      current.close(CONNECTION_CLOSE.claw_lost, "claw lost");
    } finally {
      this.probing = false;
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.abort.abort();
    await this.options.endpoint.close();
  }
}
